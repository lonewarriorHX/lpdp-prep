'use strict';

// LLM router — ported from supabase/functions/_shared/llm-router.ts
// Tries DB-managed ai_providers first (cached 60 s), then falls back to
// OPENROUTER_API_KEY / GEMINI_API_KEY env vars.

const pool = require('./db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Provider cache ----

let _cachedProviders = null;
let _cacheTime       = 0;
const CACHE_TTL      = 60_000; // 1 minute

async function fetchProvidersFromDB() {
  if (_cachedProviders && Date.now() - _cacheTime < CACHE_TTL) {
    return _cachedProviders;
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, name, provider_type, api_base_url, api_key, model,
              max_tokens, temperature, priority, extra_headers
       FROM ai_providers
       WHERE is_active = true
       ORDER BY priority ASC`,
    );

    _cachedProviders = rows.map((row) => ({
      id:            row.id,
      name:          row.name,
      provider_type: row.provider_type,
      api_base_url:  (row.api_base_url || '').replace(/\/+$/, ''),
      api_key:       row.api_key,
      model:         row.model,
      max_tokens:    row.max_tokens ?? 2500,
      temperature:   parseFloat(row.temperature ?? '0.3'),
      priority:      row.priority ?? 0,
      extra_headers: row.extra_headers ?? {},
    }));
    _cacheTime = Date.now();
    return _cachedProviders;
  } catch (e) {
    console.warn('[llm-router] Provider fetch error:', e.message);
    return [];
  }
}

function getLegacyProviders() {
  const providers = [];

  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    providers.push({
      id:            'env-openrouter',
      name:          'OpenRouter (env)',
      provider_type: 'openai_compatible',
      api_base_url:  'https://openrouter.ai/api/v1',
      api_key:       orKey,
      model:         process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free',
      max_tokens:    2500,
      temperature:   0.3,
      priority:      0,
      extra_headers: {
        'HTTP-Referer': 'https://siapstudi.com',
        'X-Title':      'SIAP Studi',
      },
    });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    providers.push({
      id:            'env-gemini',
      name:          'Gemini (env)',
      provider_type: 'openai_compatible',
      api_base_url:  'https://generativelanguage.googleapis.com/v1beta/openai',
      api_key:       geminiKey,
      model:         process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      max_tokens:    2500,
      temperature:   0.3,
      priority:      10,
      extra_headers: {},
    });
  }

  return providers;
}

// ---- Provider callers ----

const USER_AGENT = 'siapstudi.com';

async function callOpenAICompatible(provider, prompt, opts) {
  const url     = `${provider.api_base_url}/chat/completions`;
  const headers = {
    Authorization:  `Bearer ${provider.api_key}`,
    'Content-Type': 'application/json',
    'User-Agent':   USER_AGENT,
    ...provider.extra_headers,
  };

  return fetch(url, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      model:       provider.model,
      messages:    [{ role: 'user', content: prompt }],
      temperature: opts.temperature ?? provider.temperature,
      max_tokens:  opts.max_tokens  ?? provider.max_tokens,
    }),
  });
}

async function callAnthropic(provider, prompt, opts) {
  const url     = `${provider.api_base_url}/v1/messages`;
  const headers = {
    'x-api-key':         provider.api_key,
    'anthropic-version': '2023-06-01',
    'Content-Type':      'application/json',
    'User-Agent':        USER_AGENT,
    ...provider.extra_headers,
  };

  return fetch(url, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      model:       provider.model,
      messages:    [{ role: 'user', content: prompt }],
      max_tokens:  opts.max_tokens  ?? provider.max_tokens,
      temperature: opts.temperature ?? provider.temperature,
    }),
  });
}

async function callCloudflareAI(provider, prompt, opts) {
  const url     = `${provider.api_base_url}`;
  const headers = {
    Authorization:  `Bearer ${provider.api_key}`,
    'Content-Type': 'application/json',
    'User-Agent':   USER_AGENT,
    ...provider.extra_headers,
  };

  return fetch(url, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      model: provider.model,
      input: {
        messages:    [{ role: 'user', content: prompt }],
        max_tokens:  opts.max_tokens  ?? provider.max_tokens,
        temperature: opts.temperature ?? provider.temperature,
      },
    }),
  });
}

function getCallerForType(type) {
  if (type === 'anthropic') return callAnthropic;
  if (type === 'cloudflare_ai') return callCloudflareAI;
  return callOpenAICompatible;
}

async function callProviderWithRetry(provider, prompt, opts) {
  const caller = getCallerForType(provider.provider_type);

  let lastResp = null;
  let lastBody = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await caller(provider, prompt, opts);
    if (r.ok) return { resp: r };
    lastResp = r;
    lastBody = await r.text();
    if (r.status !== 503 && r.status !== 429 && r.status !== 529) break;
    if (attempt < 2) await sleep(800 * (attempt + 1));
  }

  return { resp: lastResp, errorBody: lastBody };
}

function extractText(providerType, data) {
  if (providerType === 'anthropic') {
    const blocks = data?.content;
    if (Array.isArray(blocks)) {
      return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    return '';
  }
  // Cloudflare AI wraps response in result.result
  if (providerType === 'cloudflare_ai') {
    const inner = data?.result?.result || data?.result || data;
    const msg = inner?.choices?.[0]?.message;
    return msg?.content || msg?.reasoning || inner?.response || '';
  }
  const msg = data?.choices?.[0]?.message;
  return msg?.content || msg?.reasoning || '';
}

// ---- JSON extraction helpers ----

/** Extract the first balanced {...} block from text. */
function extractJsonBlock(s) {
  if (!s) return '';
  const cleaned = s.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start   = cleaned.indexOf('{');
  if (start < 0) return cleaned;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return cleaned.slice(start);
}

/** Extract the first balanced [...] block from text. */
function extractJsonArray(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start   = cleaned.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '[') depth++;
    else if (cleaned[i] === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---- Main entry point ----

/**
 * Route an LLM prompt through configured providers.
 * @param {string} prompt
 * @param {{ temperature?: number, max_tokens?: number }} [opts]
 * @returns {Promise<{ text: string, modelUsed: string, providerName: string, providerType: string }>}
 */
async function callLLM(prompt, opts = {}) {
  const dbProviders = await fetchProvidersFromDB();
  const providers   = dbProviders.length > 0 ? dbProviders : getLegacyProviders();

  if (providers.length === 0) {
    throw new Error(
      'No LLM provider configured. Add providers in Admin > AI Settings, or set OPENROUTER_API_KEY / GEMINI_API_KEY env vars.',
    );
  }

  const errors = [];

  for (const provider of providers) {
    try {
      const { resp, errorBody } = await callProviderWithRetry(provider, prompt, opts);

      if (!resp.ok) {
        const errMsg = `${provider.name} (${provider.model}): HTTP ${resp.status} — ${(errorBody || '').slice(0, 200)}`;
        console.warn('[llm-router]', errMsg);
        errors.push(errMsg);
        continue;
      }

      const data = await resp.json();
      const text = extractText(provider.provider_type, data);

      if (!text) {
        const errMsg = `${provider.name} (${provider.model}): empty response`;
        console.warn('[llm-router]', errMsg, JSON.stringify(data).slice(0, 500));
        errors.push(errMsg);
        continue;
      }

      return {
        text,
        modelUsed:    provider.model,
        providerName: provider.name,
        providerType: provider.provider_type,
      };
    } catch (e) {
      const errMsg = `${provider.name}: ${String(e)}`;
      console.warn('[llm-router]', errMsg);
      errors.push(errMsg);
    }
  }

  throw new Error(`All LLM providers failed:\n${errors.join('\n')}`);
}

module.exports = { callLLM, extractJsonBlock, extractJsonArray };
