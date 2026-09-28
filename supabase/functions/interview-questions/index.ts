// Supabase Edge Function: interview-questions
// Generates personalized LPDP interview questions from a candidate's essay.
//
// Uses shared LLM router — reads provider config from DB (admin-managed),
// falls back to OPENROUTER_API_KEY / GEMINI_API_KEY env vars.
//
// Deploy:  supabase functions deploy interview-questions

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  callLLM,
  extractJsonArray,
  corsHeaders,
  jsonResponse,
} from "../_shared/llm-router.ts";

const ALLOWED_FOCI = ["Clarity", "Motivation", "Confidence", "Alignment", "Impact", "Relevance"];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const essay: string = (body.essay || "").toString();
    const n: number = Math.max(3, Math.min(10, parseInt(body.n, 10) || 7));
    const language: string = body.language === "en" ? "en" : "id";
    const references: Array<Record<string, string>> = Array.isArray(body.references)
      ? body.references.slice(0, 25)
      : [];

    if (!essay || essay.trim().split(/\s+/).length < 80) {
      return jsonResponse({ ok: false, error: "Essay terlalu pendek (minimal 80 kata)." }, 400);
    }

    const prompt = buildPrompt(essay, n, language, references);

    let result;
    try {
      result = await callLLM(prompt, { temperature: 0.8, max_tokens: 2500 });
    } catch (err) {
      console.error("LLM call failed:", err);
      const friendly = String(err).includes("429") || String(err).includes("rate")
        ? "Model AI sedang sibuk atau rate-limited. Coba lagi dalam beberapa saat."
        : `Gagal menghubungi AI: ${String(err).slice(0, 200)}`;
      return jsonResponse({ ok: false, error: friendly }, 502);
    }

    const text = result.text;
    if (!text) {
      return jsonResponse({ ok: false, error: "Model mengembalikan respons kosong." }, 502);
    }

    const arr = extractJsonArray(text);
    if (!Array.isArray(arr) || !arr.length) {
      console.error("Non-JSON:", text.slice(0, 600));
      return jsonResponse({ ok: false, error: "Model tidak mengembalikan JSON valid.", raw: text.slice(0, 400) }, 502);
    }

    const questions = arr
      .map((item: any) => ({
        q: String(item.q || item.question || "").trim(),
        focus: ALLOWED_FOCI.includes(item.focus) ? item.focus : "Clarity",
      }))
      .filter((x) => x.q.length > 8)
      .slice(0, n);

    if (questions.length < Math.max(3, Math.floor(n / 2))) {
      return jsonResponse({ ok: false, error: "Jumlah pertanyaan dari AI terlalu sedikit." }, 502);
    }

    return jsonResponse({ ok: true, questions });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
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
