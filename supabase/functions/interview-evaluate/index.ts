// Supabase Edge Function: interview-evaluate
// Scores an LPDP interview attempt with the LLM.
//
// Uses shared LLM router — reads provider config from DB (admin-managed),
// falls back to OPENROUTER_API_KEY / GEMINI_API_KEY env vars.
//
// Deploy:  supabase functions deploy interview-evaluate

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  callLLM,
  extractJsonBlock,
  corsHeaders,
  jsonResponse,
} from "../_shared/llm-router.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const essay: string = (body.essay || "").toString();
    const language: string = body.language === "en" ? "en" : "id";
    const qa: Array<{ q: string; focus: string; answer: string }> = Array.isArray(body.qa) ? body.qa : [];

    if (!qa.length) return jsonResponse({ ok: false, error: "Tidak ada Q&A untuk dievaluasi." }, 400);

    const prompt = buildPrompt(essay, qa, language);

    let result;
    try {
      result = await callLLM(prompt, { temperature: 0.3, max_tokens: 3000 });
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

    let evaluation: any;
    try {
      evaluation = JSON.parse(text);
    } catch {
      try {
        evaluation = JSON.parse(extractJsonBlock(text));
      } catch {
        console.error("Non-JSON:", text.slice(0, 600));
        return jsonResponse({ ok: false, error: "Model tidak mengembalikan JSON valid.", raw: text.slice(0, 400) }, 502);
      }
    }

    return jsonResponse({ ok: true, evaluation });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
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
