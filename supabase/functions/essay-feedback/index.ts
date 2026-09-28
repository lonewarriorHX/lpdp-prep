// Supabase Edge Function: essay-feedback
// Comparative feedback between the user's essay and similar awardee LPDP essays.
//
// Uses shared LLM router — reads provider config from DB (admin-managed),
// falls back to OPENROUTER_API_KEY / GEMINI_API_KEY env vars.
//
// Deploy:  supabase functions deploy essay-feedback

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  callLLM,
  extractJsonBlock,
  corsHeaders,
  jsonResponse,
} from "../_shared/llm-router.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
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
      return jsonResponse({ ok: false, error: "Essay terlalu pendek." }, 400);
    }
    if (!awardeeReferences.length) {
      return jsonResponse({ ok: false, error: "Tidak ada referensi awardee." }, 400);
    }

    const prompt = buildPrompt(userEssay, awardeeReferences, language);

    let result;
    try {
      result = await callLLM(prompt, { temperature: 0.3, max_tokens: 2500 });
    } catch (err) {
      console.error("LLM call failed:", err);
      return jsonResponse(
        { ok: false, error: String(err).includes("rate-limit") || String(err).includes("429")
          ? "Model AI sedang sibuk atau rate-limited. Coba lagi dalam beberapa saat."
          : `Gagal menghubungi AI: ${String(err).slice(0, 200)}` },
        502,
      );
    }

    const text = result.text;
    if (!text) {
      return jsonResponse(
        { ok: false, error: "Model mengembalikan respons kosong." },
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
        console.error("Non-JSON response:", text.slice(0, 800));
        return jsonResponse(
          { ok: false, error: "Model returned non-JSON.", raw: text.slice(0, 500) },
          502,
        );
      }
    }

    const safeFeedback = isPro ? feedback : redactForFreeTier(feedback);
    return jsonResponse({
      ok: true,
      feedback: safeFeedback,
      isPro,
      modelUsed: result.modelUsed,
    });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
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

GAYA BAHASA OUTPUT — sangat penting:
Tulis seperti seorang mentor LPDP yang ramah dan supportif sedang ngobrol langsung dengan kandidat — BUKAN seperti laporan formal atau review robot.
- Pakai sapaan "kamu" (bukan "Anda" yang kaku, bukan "user").
- Hindari frasa korporat seperti "esensi struktur narasi", "kekuatan argumentasi", "kuantifikasi terkuantifikasi", "sinergi", "implementasi konkret", "demonstrasikan".
- Pakai kalimat ringkas, natural, kayak teman senior yang ngasih masukan jujur tapi nggak menjatuhkan.
- Boleh kasih sentuhan empati kalau skornya rendah ("masih banyak ruang untuk diperbaiki, jangan kecil hati").
- Hindari memuji-muji berlebihan, tapi juga hindari nada menghakimi.

Untuk SETIAP aspek di bawah, kembalikan objek dengan field:
- "strength": salah satu dari "weaker" | "comparable" | "stronger" (dibanding pola awardee)
- "qualitative_label": frasa singkat dan natural dalam ${langName} (contoh: "masih lebih tipis dari awardee", "udah selevel awardee", "malah lebih kuat dari awardee rata-rata")
- "reasoning": 2-3 kalimat dengan gaya ngobrol. WAJIB sebut pola SPESIFIK yang kamu lihat di awardee vs yang dilakukan/tidak dilakukan kandidat — pakai bahasa yang konkret. Contoh: "Awardee 1 langsung buka dengan cerita di lapangan, sementara kamu masih cerita umum-umum di paragraf pertama." JANGAN abstrak/generic.
- "improvement": satu saran konkret yang bisa langsung dia kerjain hari ini (1-2 kalimat). Sebut paragraf/bagian mana yang perlu diubah dan caranya.

Aspek yang dievaluasi:
1. motivasi — alasan personal dan latar belakang memilih studi ini
2. kontribusi — rencana kontribusi nyata untuk Indonesia setelah lulus
3. rencana_studi — kejelasan rencana akademik, jurusan, target keilmuan

Tambahkan field "overall_summary": 2-3 kalimat ringkasan dalam gaya ngobrol — kayak nyimpulin obrolan ke teman.

Tambahkan juga field "similarity":
- "score": 0-100 (integer)
- "label": "Sangat Tinggi" | "Tinggi" | "Sedang" | "Rendah" (sesuaikan dengan score)
- "note": 2-3 kalimat dengan gaya HANGAT, JUJUR, dan PERSONAL — kayak ngobrol langsung sama si kandidat. JANGAN pakai bahasa formal/korporat. Sebut pola umum yang kamu liat (apa yang kuat, apa yang masih kurang) tanpa bertele-tele. Boleh kasih dorongan kecil di akhir kalau skornya di tengah-bawah.
- "per_reference": array satu objek per AWARDEE ESSAY (urutan sama), tiap objek berisi:
    - "ref_index": index awardee (mulai 1)
    - "score": 0-100 kemiripan ke awardee tsb
    - "why": 1 kalimat natural, kayak ngomong "essay-mu mirip awardee ini di [...] tapi beda di [...]"

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
      };
    }
  }
  const sum = (f.overall_summary || "").toString();
  const firstSentence = sum.split(/(?<=[.!?])\s+/)[0] || "";
  out.overall_summary = firstSentence;

  if (f.similarity) {
    out.similarity = {
      score: f.similarity.score ?? null,
      label: f.similarity.label ?? null,
      note: f.similarity.note ?? null,
    };
  }
  return out;
}
