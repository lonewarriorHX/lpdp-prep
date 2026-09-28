// Shared LLM router for all Edge Functions.
// Reads AI provider config from the `ai_providers` DB table (admin-managed),
// falls back to legacy env-var providers (OPENROUTER_API_KEY, GEMINI_API_KEY)
// when no DB providers are configured.
//
// Supports two provider types:
//   1. openai_compatible — OpenAI, OpenRouter, Groq, Together, local LLMs
//   2. anthropic         — Anthropic Messages API (Claude)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- Types ----

export interface Provider {
  id: string;
  name: string;
  provider_type: "openai_compatible" | "anthropic";
  api_base_url: string;
  api_key: string;
  model: string;
  max_tokens: number;
  temperature: number;
  priority: number;
  extra_headers: Record<string, string>;
}

export interface LLMCallOptions {
  temperature?: number;
  max_tokens?: number;
}

export interface LLMResult {
  text: string;
  modelUsed: string;
  providerName: string;
  providerType: string;
}

// ---- Helpers ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Fetch providers from DB ----

let _cachedProviders: Provider[] | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

async function fetchProvidersFromDB(): Promise<Provider[]> {
  // Simple in-memory cache to avoid hitting DB on every request
  if (_cachedProviders && Date.now() - _cacheTime < CACHE_TTL) {
    return _cachedProviders;
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return [];

  try {
    const client = createClient(url, serviceKey);
    const { data, error } = await client
      .from("ai_providers")
      .select("*")
      .eq("is_active", true)
      .order("priority", { ascending: true });

    if (error) {
      console.warn("[llm-router] Failed to fetch providers:", error.message);
      return [];
    }

    _cachedProviders = (data || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      provider_type: row.provider_type,
      api_base_url: row.api_base_url.replace(/\/+$/, ""), // strip trailing slash
      api_key: row.api_key,
      model: row.model,
      max_tokens: row.max_tokens ?? 2500,
      temperature: parseFloat(row.temperature ?? "0.3"),
      priority: row.priority ?? 0,
      extra_headers: row.extra_headers ?? {},
    }));
    _cacheTime = Date.now();
    return _cachedProviders;
  } catch (e) {
    console.warn("[llm-router] Provider fetch error:", e);
    return [];
  }
}

// ---- Legacy env-var providers (backward compatibility) ----

function getLegacyProviders(): Provider[] {
  const providers: Provider[] = [];

  const orKey = Deno.env.get("OPENROUTER_API_KEY");
  if (orKey) {
    providers.push({
      id: "env-openrouter",
      name: "OpenRouter (env)",
      provider_type: "openai_compatible",
      api_base_url: "https://openrouter.ai/api/v1",
      api_key: orKey,
      model: Deno.env.get("OPENROUTER_MODEL") || "openai/gpt-oss-120b:free",
      max_tokens: 2500,
      temperature: 0.3,
      priority: 0,
      extra_headers: {
        "HTTP-Referer": "https://siapstudi.com",
        "X-Title": "SIAP Studi",
      },
    });
  }

  // Gemini via its OpenAI-compatible endpoint
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (geminiKey) {
    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
    providers.push({
      id: "env-gemini",
      name: "Gemini (env)",
      provider_type: "openai_compatible",
      api_base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
      api_key: geminiKey,
      model: model,
      max_tokens: 2500,
      temperature: 0.3,
      priority: 10,
      extra_headers: {},
    });
  }

  return providers;
}

// ---- Provider callers ----

async function callOpenAICompatible(
  provider: Provider,
  prompt: string,
  opts: LLMCallOptions,
): Promise<Response> {
  const url = `${provider.api_base_url}/chat/completions`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${provider.api_key}`,
    "Content-Type": "application/json",
    ...provider.extra_headers,
  };

  return await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      temperature: opts.temperature ?? provider.temperature,
      max_tokens: opts.max_tokens ?? provider.max_tokens,
    }),
  });
}

async function callAnthropic(
  provider: Provider,
  prompt: string,
  opts: LLMCallOptions,
): Promise<Response> {
  // Anthropic base URL should be like https://api.anthropic.com
  const url = `${provider.api_base_url}/v1/messages`;
  const headers: Record<string, string> = {
    "x-api-key": provider.api_key,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    ...provider.extra_headers,
  };

  return await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: opts.max_tokens ?? provider.max_tokens,
      temperature: opts.temperature ?? provider.temperature,
    }),
  });
}

async function callProviderWithRetry(
  provider: Provider,
  prompt: string,
  opts: LLMCallOptions,
): Promise<{ resp: Response; errorBody?: string }> {
  const caller =
    provider.provider_type === "anthropic" ? callAnthropic : callOpenAICompatible;

  let lastResp: Response | null = null;
  let lastBody = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await caller(provider, prompt, opts);
    if (r.ok) return { resp: r };
    lastResp = r;
    lastBody = await r.text();
    // Only retry on transient errors
    if (r.status !== 503 && r.status !== 429 && r.status !== 529) break;
    if (attempt < 2) await sleep(800 * (attempt + 1));
  }

  return { resp: lastResp!, errorBody: lastBody };
}

// ---- Extract text from provider response ----

export function extractText(providerType: string, data: any): string {
  if (providerType === "anthropic") {
    // Anthropic Messages API: { content: [{ type: "text", text: "..." }] }
    const blocks = data?.content;
    if (Array.isArray(blocks)) {
      return blocks
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
    }
    return "";
  }

  // OpenAI-compatible: { choices: [{ message: { content: "..." } }] }
  const msg = data?.choices?.[0]?.message;
  return msg?.content || msg?.reasoning || "";
}

// ---- JSON extraction helpers ----

/** Extract the first balanced {...} block from text. */
export function extractJsonBlock(s: string): string {
  if (!s) return "";
  const cleaned = s.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return cleaned;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return cleaned.slice(start);
}

/** Extract the first balanced [...] block from text. */
export function extractJsonArray(text: string): any[] | null {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "[") depth++;
    else if (cleaned[i] === "]") {
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
 * Tries DB-managed providers first (sorted by priority), then falls back
 * to legacy env-var providers if no DB providers exist.
 *
 * Returns the parsed text from the first successful provider.
 * Throws if all providers fail.
 */
export async function callLLM(
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<LLMResult> {
  // 1. Try DB providers
  const dbProviders = await fetchProvidersFromDB();
  const providers = dbProviders.length > 0 ? dbProviders : getLegacyProviders();

  if (providers.length === 0) {
    throw new Error(
      "No LLM provider configured. Add providers in Admin > AI Settings, or set OPENROUTER_API_KEY / GEMINI_API_KEY env vars.",
    );
  }

  const errors: string[] = [];

  for (const provider of providers) {
    try {
      const { resp, errorBody } = await callProviderWithRetry(provider, prompt, opts);

      if (!resp.ok) {
        const errMsg = `${provider.name} (${provider.model}): HTTP ${resp.status} — ${(errorBody || "").slice(0, 200)}`;
        console.warn("[llm-router]", errMsg);
        errors.push(errMsg);
        continue;
      }

      const data = await resp.json();
      const text = extractText(provider.provider_type, data);

      if (!text) {
        const errMsg = `${provider.name} (${provider.model}): empty response`;
        console.warn("[llm-router]", errMsg, JSON.stringify(data).slice(0, 500));
        errors.push(errMsg);
        continue;
      }

      return {
        text,
        modelUsed: provider.model,
        providerName: provider.name,
        providerType: provider.provider_type,
      };
    } catch (e) {
      const errMsg = `${provider.name}: ${String(e)}`;
      console.warn("[llm-router]", errMsg);
      errors.push(errMsg);
    }
  }

  throw new Error(
    `All LLM providers failed:\n${errors.join("\n")}`,
  );
}

// ---- CORS headers (shared across all Edge Functions) ----

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
