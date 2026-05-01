// Supabase Edge Function: interview-evaluate
// Scores an LPDP interview attempt with the LLM. Uses the same
// OpenRouter -> Gemini fallback pipeline as the other functions.
//
// Deploy:  supabase functions deploy interview-evaluate
// Secrets (shared): OPENROUTER_API_KEY (primary), GEMINI_API_KEY (fallback)
//
// Request body:
//   {
//     essay: string,
//     language: 'id' | 'en',
//     qa: [{ q, focus, answer }]
//   }
//
// Response body:
//   { ok: true, evaluation: {...} }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_MODEL = Deno.env.get("OPENROUTER_MODEL") || "openai/gpt-oss-120b:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_PRIMARY_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = Deno.env.get("GEMINI_FALLBACK_MODEL") || "gemini-2.0-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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
      "X-Title": "SIAP Studi - Interview Evaluation",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 3000,
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
      generationConfig: { temperature: 0.3, maxOutputTokens: 3000 },
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
    if (GEMINI_API_KEY) return await callGeminiWithRetry(prompt);
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

function extractJsonBlock(s: string): string {
  if (!s) return "";
  let cleaned = s.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
      return json({ ok: false, error: "Tidak ada API key LLM yang di-set di server." }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const essay: string = (body.essay || "").toString();
    const language: string = body.language === "en" ? "en" : "id";
    const qa: Array<{ q: string; focus: string; answer: string }> = Array.isArray(body.qa) ? body.qa : [];

    if (!qa.length) return json({ ok: false, error: "Tidak ada Q&A untuk dievaluasi." }, 400);

    const prompt = buildPrompt(essay, qa, language);
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

    let evaluation: any;
    try {
      evaluation = JSON.parse(text);
    } catch {
      try { evaluation = JSON.parse(extractJsonBlock(text)); }
      catch {
        console.error(`${provider} non-JSON:`, text.slice(0, 600));
        return json({ ok: false, error: "Model tidak mengembalikan JSON valid.", raw: text.slice(0, 400) }, 502);
      }
    }

    return json({ ok: true, evaluation });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) }, 500);
  }
});

function buildPrompt(
  essay: string,
  qa: Array<{ q: string; focus: string; answer: string }>,
  lang: string,
) {
  const langName = lang === "en" ? "English" : "Bahasa Indonesia";
  const qaBlock = qa.map((x, i) =>
`--- Q${i + 1} [focus: ${x.focus || "Clarity"}] ---
PERTANYAAN: ${x.q}
JAWABAN: ${x.answer || "(tidak dijawab)"}`
  ).join("\n\n");

  return `Anda adalah pewawancara LPDP senior. Tugas Anda: evaluasi performa kandidat di simulasi wawancara berdasarkan jawaban mereka terhadap pertanyaan, DENGAN MEMPERHATIKAN KONSISTENSI dengan klaim di essay mereka.

Bahasa output Anda: ${langName}.

KRITERIA PENILAIAN per jawaban (skala 0-100):
- Substansi: apakah benar-benar menjawab? Pakai contoh konkret (STAR)?
- Spesifisitas: ada angka, timeline, lembaga, atau lokasi konkret?
- Confidence: bahasa tegas atau ragu (mungkin/agak/i guess)?
- Konsistensi: jawaban selaras dengan klaim di essay? Tidak bertentangan?
- LPDP relevance: terkait kontribusi Indonesia, nilai LPDP, return plan?

GUNAKAN SKALA KETAT (default mulai dari 50, naik hanya dengan bukti, turun jika lemah):
- 90+: jawaban kuat dan spesifik, awardee-tier
- 75-89: solid, beberapa polish kecil
- 60-74: cukup tapi ada celah signifikan
- 40-59: lemah, banyak yang dangkal/missing
- 0-39: sangat lemah / tidak menjawab / kontradiksi serius

Untuk per_question:
- "score": 0-100
- "feedback": 1-2 kalimat dalam ${langName} yang JUJUR dan SPESIFIK ke jawaban itu (kutip apa yang dilakukan/tidak dilakukan kandidat)
- "notes": array 0-3 saran perbaikan konkret dalam ${langName}

Untuk overall:
- "overall": 0-100 (rata-rata tertimbang per_question, dengan diskon untuk yang tidak dijawab)
- "readiness_label": "Sangat Siap" | "Cukup Siap" | "Perlu Latihan Lagi" | "Butuh Persiapan Lebih Matang"
- "summary": 2-3 kalimat ringkasan keseluruhan dalam ${langName}
- "focus_scores": objek dengan key dari fokus yang ada di Q&A (misal "Clarity": 75, "Motivation": 80, ...). Skor per fokus = rata-rata dari pertanyaan dengan fokus itu.
- "strengths": array 2-4 poin spesifik dalam ${langName}
- "weaknesses": array 2-4 poin spesifik dalam ${langName}
- "suggestions": array 3-5 saran konkret dalam ${langName}

ATURAN:
- JANGAN memuji-muji jika lemah. Jujur.
- Setiap feedback WAJIB merujuk konten spesifik dari jawaban itu.
- Output HANYA satu objek JSON valid. Karakter pertama '{', terakhir '}'. JANGAN markdown fence, JANGAN kalimat pengantar.

Struktur JSON yang HARUS dipakai:
{
  "overall": 0,
  "readiness_label": "...",
  "summary": "...",
  "focus_scores": { "Clarity": 0 },
  "per_question": [
    { "score": 0, "feedback": "...", "notes": ["..."] }
  ],
  "strengths": ["..."],
  "weaknesses": ["..."],
  "suggestions": ["..."]
}

=== ESSAY KANDIDAT (konteks) ===
${essay}

=== Q&A WAWANCARA ===
${qaBlock}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
