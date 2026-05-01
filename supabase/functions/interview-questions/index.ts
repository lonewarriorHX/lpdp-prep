// Supabase Edge Function: interview-questions
// Generates personalized LPDP interview questions from a candidate's essay,
// using the same OpenRouter -> Gemini fallback pipeline as essay-feedback.
//
// Deploy:  supabase functions deploy interview-questions
// Secrets (shared with essay-feedback):
//   OPENROUTER_API_KEY (primary), GEMINI_API_KEY (fallback)
//
// Request body:
//   {
//     essay: string,
//     n: number (3-10),
//     language: 'id' | 'en',
//     references: [{ question, focus, notes }]   // optional seed material
//   }
//
// Response body:
//   { ok: true, questions: [{ q, focus }] }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_MODEL = Deno.env.get("OPENROUTER_MODEL") || "openai/gpt-oss-120b:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_PRIMARY_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = Deno.env.get("GEMINI_FALLBACK_MODEL") || "gemini-2.0-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const ALLOWED_FOCI = ["Clarity", "Motivation", "Confidence", "Alignment", "Impact", "Relevance"];

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- OpenRouter ----------
async function callOpenRouter(prompt: string) {
  return await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://lpdp-prep.app",
      "X-Title": "SIAP Studi - Interview Questions",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
      max_tokens: 2500,
    }),
  });
}

async function callOpenRouterWithRetry(prompt: string) {
  let lastResp: Response | null = null;
  let lastBody = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await callOpenRouter(prompt);
    if (r.ok) return { resp: r, provider: "openrouter" };
    lastResp = r;
    lastBody = await r.text();
    if (r.status !== 503 && r.status !== 429) break;
    if (attempt < 2) await sleep(800 * (attempt + 1));
  }
  return { resp: lastResp!, provider: "openrouter", errorBody: lastBody };
}

// ---------- Gemini ----------
async function callGemini(model: string, prompt: string) {
  return await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 2500,
      },
    }),
  });
}

async function callGeminiWithRetry(prompt: string) {
  let lastResp: Response | null = null;
  let lastBody = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await callGemini(GEMINI_PRIMARY_MODEL, prompt);
    if (r.ok) return { resp: r, provider: "gemini" };
    lastResp = r;
    lastBody = await r.text();
    if (r.status !== 503 && r.status !== 429) break;
    if (attempt < 2) await sleep(800 * (attempt + 1));
  }
  if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_PRIMARY_MODEL) {
    const r = await callGemini(GEMINI_FALLBACK_MODEL, prompt);
    if (r.ok) return { resp: r, provider: "gemini" };
    lastResp = r;
    lastBody = await r.text();
  }
  return { resp: lastResp!, provider: "gemini", errorBody: lastBody };
}

async function callLLM(prompt: string) {
  if (OPENROUTER_API_KEY) {
    const or = await callOpenRouterWithRetry(prompt);
    if (or.resp?.ok) return or;
    console.warn("OpenRouter failed:", or.resp?.status, or.errorBody?.slice(0, 200));
    if (GEMINI_API_KEY) {
      return await callGeminiWithRetry(prompt);
    }
    return or;
  }
  if (GEMINI_API_KEY) return await callGeminiWithRetry(prompt);
  throw new Error("No LLM provider configured.");
}

function extractText(provider: string, data: any): string {
  if (provider === "openrouter") {
    const msg = data?.choices?.[0]?.message;
    return msg?.content || msg?.reasoning || "";
  }
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Pull first JSON array out of mixed text (model may add prose / fences).
function extractJsonArray(text: string): any[] | null {
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
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
      return json({ ok: false, error: "Tidak ada API key LLM yang di-set di server." }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const essay: string = (body.essay || "").toString();
    const n: number = Math.max(3, Math.min(10, parseInt(body.n, 10) || 7));
    const language: string = body.language === "en" ? "en" : "id";
    const references: Array<Record<string, string>> = Array.isArray(body.references)
      ? body.references.slice(0, 25)
      : [];

    if (!essay || essay.trim().split(/\s+/).length < 80) {
      return json({ ok: false, error: "Essay terlalu pendek (minimal 80 kata)." }, 400);
    }

    const prompt = buildPrompt(essay, n, language, references);
    const { resp: r, provider, errorBody } = await callLLM(prompt);

    if (!r.ok) {
      const txt = errorBody ?? (await r.text());
      console.error(`${provider} error:`, r.status, txt);
      const friendly = (r.status === 503 || r.status === 429)
        ? "Model AI sedang sibuk atau rate-limited. Coba lagi dalam beberapa saat."
        : `LLM API error ${r.status}: ${txt.slice(0, 200)}`;
      return json({ ok: false, error: friendly }, 502);
    }

    const data = await r.json();
    const text = extractText(provider, data);
    if (!text) {
      console.error(`${provider} empty response:`, JSON.stringify(data).slice(0, 800));
      return json({ ok: false, error: "Model mengembalikan respons kosong." }, 502);
    }

    const arr = extractJsonArray(text);
    if (!Array.isArray(arr) || !arr.length) {
      console.error(`${provider} non-JSON:`, text.slice(0, 600));
      return json({ ok: false, error: "Model tidak mengembalikan JSON valid.", raw: text.slice(0, 400) }, 502);
    }

    const questions = arr
      .map((item: any) => ({
        q: String(item.q || item.question || "").trim(),
        focus: ALLOWED_FOCI.includes(item.focus) ? item.focus : "Clarity",
      }))
      .filter((x) => x.q.length > 8)
      .slice(0, n);

    if (questions.length < Math.max(3, Math.floor(n / 2))) {
      return json({ ok: false, error: "Jumlah pertanyaan dari AI terlalu sedikit." }, 502);
    }

    return json({ ok: true, questions });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) }, 500);
  }
});

function buildPrompt(
  essay: string,
  n: number,
  lang: string,
  refs: Array<Record<string, string>>,
) {
  const langName = lang === "en" ? "English" : "Bahasa Indonesia";
  const langInstr = lang === "en"
    ? "Write every question in fluent, natural English."
    : 'Tulis setiap pertanyaan dalam Bahasa Indonesia yang natural dan tajam (gunakan "kamu" / "Anda" konsisten).';

  const refList = refs
    .map((r, i) => `${i + 1}. [${r.focus || "?"}] ${r.question}${r.notes ? "  (catatan: " + r.notes + ")" : ""}`)
    .join("\n");

  return `Anda adalah pewawancara LPDP senior di Indonesia.
Tugas Anda: baca essay kandidat, lalu buat pertanyaan wawancara yang TAJAM, PERSONAL, dan menggali:
- klaim yang vague atau tidak terbukti
- angka/timeline yang dibutuhkan tapi tidak disebutkan
- celah motivasi atau alignment dengan misi LPDP
- ketegangan antara rencana kontribusi dan kelayakan teknis/finansial
- asumsi tersembunyi

ATURAN PENTING:
- Setiap pertanyaan WAJIB merujuk sesuatu yang spesifik dari essay (jangan generic).
- Mix tipe: 1 perkenalan, 1 motivasi, beberapa essay-specific challenge, 1 kontribusi/return-to-Indonesia, 1 curveball.
- Setiap pertanyaan harus punya "focus" tag dari set ini SAJA: ${ALLOWED_FOCI.join(", ")}.
- ${langInstr}
- Output HANYA JSON array. Karakter PERTAMA harus '[' dan TERAKHIR harus ']'. JANGAN markdown fence, JANGAN kalimat pengantar.

Format: [{"q": "...", "focus": "Motivation"}, ...]

REFERENCE QUESTIONS (gunakan sebagai inspirasi tone, kedalaman, dan gaya follow-up — JANGAN salin verbatim):
${refList || "(belum ada pertanyaan referensi — andalkan best practice wawancara LPDP)"}

CANDIDATE ESSAY:
"""
${essay}
"""

Buat tepat ${n} pertanyaan wawancara dalam ${langName}, dipersonalisasi dari essay di atas. Output JSON array saja.`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
