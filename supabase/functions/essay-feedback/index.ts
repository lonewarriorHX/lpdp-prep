// Supabase Edge Function: essay-feedback
// Calls Google Gemini Flash to generate comparative feedback between
// the user's essay and the most similar awardee (winning) LPDP essays.
//
// Deploy:  supabase functions deploy essay-feedback
// Secrets: supabase secrets set GEMINI_API_KEY=<your_key>
//
// Request body:
//   {
//     userEssay: string,
//     language: 'id' | 'en',
//     awardeeReferences: [{ title, author, university, excerpt }]
//   }
//
// Response body:
//   { ok: true, feedback: { motivasi: {...}, kontribusi: {...},
//                           rencana_studi: {...}, overall_summary: '...' } }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const GEMINI_PRIMARY_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = Deno.env.get("GEMINI_FALLBACK_MODEL") || "gemini-2.0-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function geminiUrl(model: string) {
  return `${GEMINI_BASE}/${model}:generateContent`;
}

async function callGemini(model: string, prompt: string) {
  return await fetch(`${geminiUrl(model)}?key=${GEMINI_API_KEY}`, {
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
  // Try primary model up to 3 times with exponential backoff on 503/429,
  // then fall back to secondary model once.
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  let lastResp: Response | null = null;
  let lastBody = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await callGemini(GEMINI_PRIMARY_MODEL, prompt);
    if (r.ok) return { resp: r, modelUsed: GEMINI_PRIMARY_MODEL };
    lastResp = r;
    lastBody = await r.text();
    if (r.status !== 503 && r.status !== 429) break;
    if (attempt < 2) await sleep(800 * (attempt + 1));
  }

  // Fall back to secondary model
  if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_PRIMARY_MODEL) {
    const r = await callGemini(GEMINI_FALLBACK_MODEL, prompt);
    if (r.ok) return { resp: r, modelUsed: GEMINI_FALLBACK_MODEL };
    lastResp = r;
    lastBody = await r.text();
  }

  return { resp: lastResp!, modelUsed: null, errorBody: lastBody };
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
    if (!GEMINI_API_KEY) {
      return json({ ok: false, error: "GEMINI_API_KEY belum di-set di server." }, 500);
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
      ? body.awardeeReferences.slice(0, 5)
      : [];

    if (!userEssay || userEssay.trim().length < 200) {
      return json({ ok: false, error: "Essay terlalu pendek." }, 400);
    }
    if (!awardeeReferences.length) {
      return json({ ok: false, error: "Tidak ada referensi awardee." }, 400);
    }

    const prompt = buildPrompt(userEssay, awardeeReferences, language);

    const { resp: r, modelUsed, errorBody } = await callGeminiWithRetry(prompt);

    if (!r.ok) {
      const txt = errorBody ?? (await r.text());
      console.error("Gemini error:", r.status, txt);
      const friendly = r.status === 503
        ? "Model Gemini sedang sibuk. Coba lagi dalam beberapa saat."
        : `Gemini API error ${r.status}: ${txt.slice(0, 200)}`;
      return json({ ok: false, error: friendly }, 502);
    }

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    let feedback: unknown;
    try {
      feedback = JSON.parse(text);
    } catch {
      // Last-ditch: strip ```json fences if model wrapped it
      const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
      try {
        feedback = JSON.parse(cleaned);
      } catch {
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
      return `${head}\n${(r.excerpt || r.content || "").slice(0, 2500)}`;
    })
    .join("\n\n");

  const langName = lang === "en" ? "English" : "Bahasa Indonesia";

  return `Anda adalah evaluator essay beasiswa LPDP berpengalaman. Tugas Anda: bandingkan ESSAY USER dengan AWARDEE_REFERENCES (essay yang lolos seleksi LPDP) dan beri feedback komparatif yang JUJUR dan SPESIFIK.

Bahasa essay: ${langName}.
Bahasa output Anda: ${langName}.

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

ATURAN PENTING:
- JANGAN gunakan persentase numerik palsu (jangan tulis "70% awardee..."). Pakai label kualitatif.
- JANGAN memuji-muji jika memang lemah. Jujur.
- JIKA essay user benar-benar lebih baik di suatu aspek, akui dengan "stronger".
- Output HANYA JSON valid, tanpa fence markdown, tanpa kalimat pengantar.

Struktur JSON yang HARUS dipakai:
{
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
  return out;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
