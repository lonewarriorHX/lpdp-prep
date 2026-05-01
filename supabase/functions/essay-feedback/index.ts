// Supabase Edge Function: essay-feedback
// Comparative feedback between the user's essay and similar awardee LPDP essays.
// Primary provider: OpenRouter. Fallback provider: Google Gemini.
//
// Deploy:  supabase functions deploy essay-feedback
// Secrets:
//   supabase secrets set OPENROUTER_API_KEY=<sk-or-v1-...>     (primary)
//   supabase secrets set GEMINI_API_KEY=<your_key>             (fallback, optional)
//
// Optional overrides:
//   OPENROUTER_MODEL          default: openai/gpt-oss-120b:free
//   GEMINI_MODEL              default: gemini-2.5-flash
//   GEMINI_FALLBACK_MODEL     default: gemini-2.0-flash

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_MODEL = Deno.env.get("OPENROUTER_MODEL") || "openai/gpt-oss-120b:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_PRIMARY_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = Deno.env.get("GEMINI_FALLBACK_MODEL") || "gemini-2.0-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ---------- OpenRouter ----------
async function callOpenRouter(prompt: string) {
  // Many open-source models on OpenRouter (incl. gpt-oss-120b) don't honor
  // response_format: json_object — we rely on prompt instructions instead.
  return await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://lpdp-prep.app",
      "X-Title": "SIAP Studi - Essay Feedback",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 2500,
    }),
  });
}

async function callOpenRouterWithRetry(prompt: string) {
  let lastResp: Response | null = null;
  let lastBody = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await callOpenRouter(prompt);
    if (r.ok) return { resp: r, modelUsed: OPENROUTER_MODEL, provider: "openrouter" };
    lastResp = r;
    lastBody = await r.text();
    if (r.status !== 503 && r.status !== 429) break;
    if (attempt < 2) await sleep(800 * (attempt + 1));
  }
  return { resp: lastResp!, modelUsed: null, provider: "openrouter", errorBody: lastBody };
}

// ---------- Gemini ----------
async function callGemini(model: string, prompt: string) {
  return await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1500,
        responseMimeType: "application/json",
      },
    }),
  });
}

async function callGeminiWithRetry(prompt: string) {
  let lastResp: Response | null = null;
  let lastBody = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await callGemini(GEMINI_PRIMARY_MODEL, prompt);
    if (r.ok) return { resp: r, modelUsed: GEMINI_PRIMARY_MODEL, provider: "gemini" };
    lastResp = r;
    lastBody = await r.text();
    if (r.status !== 503 && r.status !== 429) break;
    if (attempt < 2) await sleep(800 * (attempt + 1));
  }

  if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_PRIMARY_MODEL) {
    const r = await callGemini(GEMINI_FALLBACK_MODEL, prompt);
    if (r.ok) return { resp: r, modelUsed: GEMINI_FALLBACK_MODEL, provider: "gemini" };
    lastResp = r;
    lastBody = await r.text();
  }

  return { resp: lastResp!, modelUsed: null, provider: "gemini", errorBody: lastBody };
}

// ---------- Provider router ----------
async function callLLM(prompt: string) {
  if (OPENROUTER_API_KEY) {
    const or = await callOpenRouterWithRetry(prompt);
    if (or.resp?.ok) return or;
    console.warn("OpenRouter failed:", or.resp?.status, or.errorBody?.slice(0, 200));
    if (GEMINI_API_KEY) {
      const gm = await callGeminiWithRetry(prompt);
      if (gm.resp?.ok) return gm;
      return gm;
    }
    return or;
  }
  if (GEMINI_API_KEY) {
    return await callGeminiWithRetry(prompt);
  }
  throw new Error("No LLM provider configured (set OPENROUTER_API_KEY or GEMINI_API_KEY).");
}

// Extract response text in a provider-agnostic way.
// Reasoning models (gpt-oss, deepseek-r1, etc.) sometimes put the actual
// answer in `reasoning` instead of `content` — try both.
function extractText(provider: string, data: any): string {
  if (provider === "openrouter") {
    const msg = data?.choices?.[0]?.message;
    return msg?.content || msg?.reasoning || "";
  }
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Pull the first balanced {...} block out of a string. Reasoning models
// often wrap JSON in explanatory text or markdown fences.
function extractJsonBlock(s: string): string {
  if (!s) return "";
  // Strip ```json or ``` fences
  let cleaned = s.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  // Find first { and matching final } using brace counting
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
      return json(
        { ok: false, error: "Tidak ada API key LLM yang di-set di server (OPENROUTER_API_KEY atau GEMINI_API_KEY)." },
        500,
      );
    }

    // ---- Identify caller and check Pro status ----
    const authHeader = req.headers.get("Authorization") || "";
    let isPro = false;
    if (SUPABASE_URL && SUPABASE_ANON_KEY && authHeader.startsWith("Bearer ")) {
      try {
        const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data: { user } } = await userClient.auth.getUser();
        if (user) {
          const { data: profile } = await userClient
            .from("profiles")
            .select("is_pro")
            .eq("id", user.id)
            .maybeSingle();
          isPro = !!profile?.is_pro;
        }
      } catch (e) {
        console.warn("profile lookup failed:", e);
      }
    }

    const body = await req.json().catch(() => ({}));
    const userEssay: string = (body.userEssay || "").toString();
    const language: string = body.language === "en" ? "en" : "id";
    const awardeeReferences: Array<Record<string, string>> = Array.isArray(
      body.awardeeReferences,
    )
      ? body.awardeeReferences.slice(0, 3)
      : [];

    if (!userEssay || userEssay.trim().length < 200) {
      return json({ ok: false, error: "Essay terlalu pendek." }, 400);
    }
    if (!awardeeReferences.length) {
      return json({ ok: false, error: "Tidak ada referensi awardee." }, 400);
    }

    const prompt = buildPrompt(userEssay, awardeeReferences, language);

    const { resp: r, modelUsed, provider, errorBody } = await callLLM(prompt);

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
      console.error(`${provider} empty response. Full data:`, JSON.stringify(data).slice(0, 1000));
      return json(
        {
          ok: false,
          error: "Model mengembalikan respons kosong. Mungkin rate-limit atau model tidak mendukung prompt ini.",
          finishReason: data?.choices?.[0]?.finish_reason ?? null,
        },
        502,
      );
    }

    let feedback: unknown;
    try {
      feedback = JSON.parse(text);
    } catch {
      const block = extractJsonBlock(text);
      try {
        feedback = JSON.parse(block);
      } catch {
        console.error(`${provider} non-JSON response:`, text.slice(0, 800));
        return json(
          { ok: false, error: "Model returned non-JSON.", raw: text.slice(0, 500) },
          502,
        );
      }
    }

    const safeFeedback = isPro ? feedback : redactForFreeTier(feedback);
    return json({ ok: true, feedback: safeFeedback, isPro, modelUsed });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) }, 500);
  }
});

function buildPrompt(
  userEssay: string,
  refs: Array<Record<string, string>>,
  lang: string,
) {
  const refBlock = refs
    .map((r, i) => {
      const head = [
        `--- AWARDEE ESSAY ${i + 1}`,
        r.title ? `(${r.title})` : "",
        r.university ? `— ${r.university}` : "",
        "---",
      ]
        .filter(Boolean)
        .join(" ");
      return `${head}\n${(r.excerpt || r.content || "").slice(0, 1200)}`;
    })
    .join("\n\n");

  const langName = lang === "en" ? "English" : "Bahasa Indonesia";

  return `Anda adalah evaluator essay beasiswa LPDP berpengalaman. Tugas Anda: bandingkan ESSAY USER dengan AWARDEE_REFERENCES (essay yang lolos seleksi LPDP) dan beri feedback komparatif yang JUJUR dan SPESIFIK.

Bahasa essay: ${langName}.
Bahasa output Anda: ${langName}.

PENILAIAN KEMIRIPAN (similarity):
Selain feedback per aspek, beri penilaian semantik seberapa mirip pola essay user dengan pola awardee. Bukan hanya kemiripan kata, tapi juga: kekuatan narasi, kedalaman refleksi pengalaman, kejelasan rencana, dan kualitas argumen kontribusi.

GUNAKAN SKALA KETAT (jangan mudah memberi skor tinggi). Default mulai dari 50, NAIK hanya jika ada bukti konkret keunggulan, TURUN jika ada kelemahan jelas:
- 95-100: Sangat Tinggi — sangat jarang. Hanya jika essay user benar-benar setara atau lebih baik dari awardee dalam SEMUA dimensi (narasi, kedalaman, kejelasan rencana, kontribusi konkret terkuantifikasi).
- 85-94:  Tinggi (LAYAK LOLOS) — pola, kedalaman, dan kekuatan argumen sudah konsisten dengan awardee. Beberapa polish kecil saja.
- 65-84:  Sedang — sebagian besar elemen ada tapi ada kelemahan signifikan di minimal satu aspek (misal: motivasi masih abstrak, atau kontribusi belum konkret, atau rencana pasca studi vague).
- 40-64:  Rendah — banyak elemen kunci hilang atau dangkal. Butuh revisi besar di beberapa aspek.
- 0-39:   Sangat Rendah — jauh dari standar awardee. Hampir semua aspek butuh dirombak.

PENTING: skor 85+ berarti essay HAMPIR LAYAK LOLOS LPDP. Jangan obral skor itu. Jika ragu antara dua band, pilih band yang LEBIH RENDAH.

Untuk SETIAP aspek di bawah, kembalikan objek dengan field:
- "strength": salah satu dari "weaker" | "comparable" | "stronger" (dibanding pola awardee)
- "qualitative_label": frasa singkat dalam ${langName} (contoh: "lebih lemah dibanding sebagian besar awardee", "setara dengan awardee", "lebih kuat dari awardee rata-rata")
- "reasoning": 2-3 kalimat. WAJIB kutip pola spesifik yang Anda lihat di awardee references vs yang dilakukan/tidak dilakukan user. Contoh kutipan: "Awardee 1 membuka dengan cerita lapangan konkret..." JANGAN generic.
- "improvement": satu saran konkret dan bisa langsung diterapkan (1-2 kalimat). Sebut paragraf/bagian mana yang harus diubah dan bagaimana.

Aspek yang dievaluasi:
1. motivasi — alasan personal dan latar belakang memilih studi ini
2. kontribusi — rencana kontribusi nyata untuk Indonesia setelah lulus
3. rencana_studi — kejelasan rencana akademik, jurusan, target keilmuan

Tambahkan field "overall_summary": 2-3 kalimat ringkasan keseluruhan dalam ${langName}.

Tambahkan juga field "similarity":
- "score": 0-100 (integer)
- "label": "Sangat Tinggi" | "Tinggi" | "Sedang" | "Rendah" (sesuaikan dengan score)
- "note": 1-2 kalimat menjelaskan mengapa skor itu dalam ${langName}
- "per_reference": array satu objek per AWARDEE ESSAY (urutan sama), tiap objek berisi:
    - "ref_index": index awardee (mulai 1)
    - "score": 0-100 kemiripan ke awardee tsb
    - "why": 1 kalimat alasan singkat dalam ${langName}

ATURAN PENTING:
- JANGAN gunakan persentase numerik palsu (jangan tulis "70% awardee..."). Pakai label kualitatif.
- JANGAN memuji-muji jika memang lemah. Jujur.
- JIKA essay user benar-benar lebih baik di suatu aspek, akui dengan "stronger".
- Output HANYA satu objek JSON valid. Karakter PERTAMA respons Anda harus '{' dan karakter TERAKHIR harus '}'.
- JANGAN gunakan markdown code fence (\`\`\`). JANGAN tulis kalimat pengantar atau penutup.
- JANGAN tulis chain-of-thought atau reasoning di luar JSON.

Struktur JSON yang HARUS dipakai:
{
  "similarity": {
    "score": 0,
    "label": "...",
    "note": "...",
    "per_reference": [
      { "ref_index": 1, "score": 0, "why": "..." }
    ]
  },
  "motivasi": { "strength": "...", "qualitative_label": "...", "reasoning": "...", "improvement": "..." },
  "kontribusi": { "strength": "...", "qualitative_label": "...", "reasoning": "...", "improvement": "..." },
  "rencana_studi": { "strength": "...", "qualitative_label": "...", "reasoning": "...", "improvement": "..." },
  "overall_summary": "..."
}

=== USER ESSAY ===
${userEssay}

=== AWARDEE REFERENCES ===
${refBlock}`;
}

// Strip detailed reasoning + improvement for non-Pro users.
// They still see the verdict (strength + qualitative_label) and the first
// sentence of overall_summary, so they know whether to upgrade.
function redactForFreeTier(fb: unknown): unknown {
  if (!fb || typeof fb !== "object") return fb;
  const f = fb as Record<string, any>;
  const aspects = ["motivasi", "kontribusi", "rencana_studi"];
  const out: Record<string, any> = {};
  for (const k of aspects) {
    if (f[k]) {
      out[k] = {
        strength: f[k].strength ?? null,
        qualitative_label: f[k].qualitative_label ?? null,
        // reasoning + improvement intentionally omitted
      };
    }
  }
  // Keep only first sentence of overall_summary as a teaser
  const sum = (f.overall_summary || "").toString();
  const firstSentence = sum.split(/(?<=[.!?])\s+/)[0] || "";
  out.overall_summary = firstSentence;

  // Keep AI similarity score+label+note (numeric, fine for free tier).
  // Drop per_reference reasoning since that's analytic detail.
  if (f.similarity) {
    out.similarity = {
      score: f.similarity.score ?? null,
      label: f.similarity.label ?? null,
      note: f.similarity.note ?? null,
    };
  }
  return out;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
