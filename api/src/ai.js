'use strict';

// AI/LLM endpoints — replaces Supabase Edge Functions.
// Prompts are ported verbatim from:
//   supabase/functions/essay-feedback/index.ts
//   supabase/functions/interview-questions/index.ts
//   supabase/functions/interview-evaluate/index.ts

const express = require('express');
const pool    = require('./db');
const { requireAuth }                    = require('./auth');
const { callLLM, extractJsonBlock, extractJsonArray } = require('./llm-router');

const router = express.Router();

// ---- Helpers ----

async function getIsPro(userId) {
  if (!userId) return false;
  try {
    const { rows } = await pool.query('SELECT is_pro FROM profiles WHERE id = $1', [userId]);
    return rows.length > 0 && !!rows[0].is_pro;
  } catch {
    return false;
  }
}

function redactForFreeTier(fb) {
  if (!fb || typeof fb !== 'object') return fb;
  const aspects = ['motivasi', 'kontribusi', 'rencana_studi'];
  const out     = {};
  for (const k of aspects) {
    if (fb[k]) {
      out[k] = {
        strength:         fb[k].strength         ?? null,
        qualitative_label: fb[k].qualitative_label ?? null,
      };
    }
  }
  const sum          = (fb.overall_summary || '').toString();
  out.overall_summary = sum.split(/(?<=[.!?])\s+/)[0] || '';

  if (fb.similarity) {
    out.similarity = {
      score: fb.similarity.score ?? null,
      label: fb.similarity.label ?? null,
      note:  fb.similarity.note  ?? null,
    };
  }
  return out;
}

// ---- Prompt builders (ported verbatim from Edge Functions) ----

const ALLOWED_FOCI = ['Clarity', 'Motivation', 'Confidence', 'Alignment', 'Impact', 'Relevance'];

function buildEssayFeedbackPrompt(userEssay, refs, lang) {
  const refBlock = refs
    .map((r, i) => {
      const head = [
        `--- AWARDEE ESSAY ${i + 1}`,
        r.title      ? `(${r.title})`      : '',
        r.university ? `— ${r.university}` : '',
        '---',
      ].filter(Boolean).join(' ');
      return `${head}\n${(r.excerpt || r.content || '').slice(0, 1200)}`;
    })
    .join('\n\n');

  const langName = lang === 'en' ? 'English' : 'Bahasa Indonesia';

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

function buildInterviewQuestionsPrompt(essay, n, lang, refs) {
  const langName = lang === 'en' ? 'English' : 'Bahasa Indonesia';
  const langInstr = lang === 'en'
    ? 'Write every question in fluent, natural English.'
    : 'Tulis setiap pertanyaan dalam Bahasa Indonesia yang natural dan tajam (gunakan "kamu" / "Anda" konsisten).';

  const refList = refs
    .map((r, i) => `${i + 1}. [${r.focus || '?'}] ${r.question}${r.notes ? '  (catatan: ' + r.notes + ')' : ''}`)
    .join('\n');

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
- Setiap pertanyaan harus punya "focus" tag dari set ini SAJA: ${ALLOWED_FOCI.join(', ')}.
- ${langInstr}
- Output HANYA JSON array. Karakter PERTAMA harus '[' dan TERAKHIR harus ']'. JANGAN markdown fence, JANGAN kalimat pengantar.

Format: [{"q": "...", "focus": "Motivation"}, ...]

REFERENCE QUESTIONS (gunakan sebagai inspirasi tone, kedalaman, dan gaya follow-up — JANGAN salin verbatim):
${refList || '(belum ada pertanyaan referensi — andalkan best practice wawancara LPDP)'}

CANDIDATE ESSAY:
"""
${essay}
"""

Buat tepat ${n} pertanyaan wawancara dalam ${langName}, dipersonalisasi dari essay di atas. Output JSON array saja.`;
}

function buildInterviewEvaluatePrompt(essay, qa, lang) {
  const langName = lang === 'en' ? 'English' : 'Bahasa Indonesia';
  const qaBlock  = qa.map((x, i) =>
`--- Q${i + 1} [focus: ${x.focus || 'Clarity'}] ---
PERTANYAAN: ${x.q}
JAWABAN: ${x.answer || '(tidak dijawab)'}`
  ).join('\n\n');

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

// ---- Routes ----

// POST /fn/essay-feedback
router.post('/essay-feedback', requireAuth, async (req, res) => {
  try {
    const { userEssay, language, awardeeReferences } = req.body || {};

    const essay = (userEssay || '').toString();
    const lang  = language === 'en' ? 'en' : 'id';
    const refs  = Array.isArray(awardeeReferences) ? awardeeReferences.slice(0, 3) : [];

    if (!essay || essay.trim().length < 200) {
      return res.status(400).json({ ok: false, error: 'Essay terlalu pendek.' });
    }
    if (!refs.length) {
      return res.status(400).json({ ok: false, error: 'Tidak ada referensi awardee.' });
    }

    const isPro  = await getIsPro(req.userId);
    const prompt = buildEssayFeedbackPrompt(essay, refs, lang);

    let result;
    try {
      result = await callLLM(prompt, { temperature: 0.3, max_tokens: 8000 });
    } catch (err) {
      console.error('[ai] essay-feedback LLM error:', err.message);
      const friendly = String(err).includes('rate-limit') || String(err).includes('429')
        ? 'Model AI sedang sibuk atau rate-limited. Coba lagi dalam beberapa saat.'
        : `Gagal menghubungi AI: ${String(err).slice(0, 200)}`;
      return res.status(502).json({ ok: false, error: friendly });
    }

    if (!result.text) {
      return res.status(502).json({ ok: false, error: 'Model mengembalikan respons kosong.' });
    }

    let feedback;
    try {
      feedback = JSON.parse(result.text);
    } catch {
      try {
        feedback = JSON.parse(extractJsonBlock(result.text));
      } catch {
        console.error('[ai] Non-JSON response:', result.text.slice(0, 800));
        return res.status(502).json({ ok: false, error: 'Model returned non-JSON.', raw: result.text.slice(0, 500) });
      }
    }

    const safeFeedback = isPro ? feedback : redactForFreeTier(feedback);
    return res.json({ ok: true, feedback: safeFeedback, isPro, modelUsed: result.modelUsed });
  } catch (err) {
    console.error('[ai] essay-feedback error:', err.message);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /fn/interview-questions
router.post('/interview-questions', requireAuth, async (req, res) => {
  try {
    const { essay, n: rawN, language, references } = req.body || {};

    const essayText = (essay || '').toString();
    const n         = Math.max(3, Math.min(10, parseInt(rawN, 10) || 7));
    const lang      = language === 'en' ? 'en' : 'id';
    const refs      = Array.isArray(references) ? references.slice(0, 25) : [];

    if (!essayText || essayText.trim().split(/\s+/).length < 80) {
      return res.status(400).json({ ok: false, error: 'Essay terlalu pendek (minimal 80 kata).' });
    }

    const prompt = buildInterviewQuestionsPrompt(essayText, n, lang, refs);

    let result;
    try {
      result = await callLLM(prompt, { temperature: 0.8, max_tokens: 4000 });
    } catch (err) {
      console.error('[ai] interview-questions LLM error:', err.message);
      const friendly = String(err).includes('429') || String(err).includes('rate')
        ? 'Model AI sedang sibuk atau rate-limited. Coba lagi dalam beberapa saat.'
        : `Gagal menghubungi AI: ${String(err).slice(0, 200)}`;
      return res.status(502).json({ ok: false, error: friendly });
    }

    if (!result.text) {
      return res.status(502).json({ ok: false, error: 'Model mengembalikan respons kosong.' });
    }

    const arr = extractJsonArray(result.text);
    if (!Array.isArray(arr) || !arr.length) {
      console.error('[ai] Non-JSON array:', result.text.slice(0, 600));
      return res.status(502).json({ ok: false, error: 'Model tidak mengembalikan JSON valid.', raw: result.text.slice(0, 400) });
    }

    const questions = arr
      .map((item) => ({
        q:     String(item.q || item.question || '').trim(),
        focus: ALLOWED_FOCI.includes(item.focus) ? item.focus : 'Clarity',
      }))
      .filter((x) => x.q.length > 8)
      .slice(0, n);

    if (questions.length < Math.max(3, Math.floor(n / 2))) {
      return res.status(502).json({ ok: false, error: 'Jumlah pertanyaan dari AI terlalu sedikit.' });
    }

    return res.json({ ok: true, questions });
  } catch (err) {
    console.error('[ai] interview-questions error:', err.message);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /fn/interview-evaluate
router.post('/interview-evaluate', requireAuth, async (req, res) => {
  try {
    const { essay, language, qa } = req.body || {};

    const essayText = (essay || '').toString();
    const lang      = language === 'en' ? 'en' : 'id';
    const qaList    = Array.isArray(qa) ? qa : [];

    if (!qaList.length) {
      return res.status(400).json({ ok: false, error: 'Tidak ada Q&A untuk dievaluasi.' });
    }

    const prompt = buildInterviewEvaluatePrompt(essayText, qaList, lang);

    let result;
    try {
      result = await callLLM(prompt, { temperature: 0.3, max_tokens: 8000 });
    } catch (err) {
      console.error('[ai] interview-evaluate LLM error:', err.message);
      const friendly = String(err).includes('429') || String(err).includes('rate')
        ? 'Model AI sedang sibuk atau rate-limited. Coba lagi dalam beberapa saat.'
        : `Gagal menghubungi AI: ${String(err).slice(0, 200)}`;
      return res.status(502).json({ ok: false, error: friendly });
    }

    if (!result.text) {
      return res.status(502).json({ ok: false, error: 'Model mengembalikan respons kosong.' });
    }

    let evaluation;
    try {
      evaluation = JSON.parse(result.text);
    } catch {
      try {
        evaluation = JSON.parse(extractJsonBlock(result.text));
      } catch {
        console.error('[ai] Non-JSON:', result.text.slice(0, 600));
        return res.status(502).json({ ok: false, error: 'Model tidak mengembalikan JSON valid.', raw: result.text.slice(0, 400) });
      }
    }

    return res.json({ ok: true, evaluation });
  } catch (err) {
    console.error('[ai] interview-evaluate error:', err.message);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---- Test provider connection ----
router.post('/test-provider', requireAuth, async (req, res) => {
  // Check admin
  try {
    const { rows } = await pool.query('SELECT is_admin FROM profiles WHERE id = $1', [req.userId]);
    if (!rows[0]?.is_admin) return res.status(403).json({ ok: false, error: 'Admin only.' });
  } catch { return res.status(403).json({ ok: false, error: 'Admin check failed.' }); }

  const { provider_type, api_base_url, api_key, model, extra_headers, provider_id } = req.body;

  let config;
  if (provider_id) {
    // Test existing provider from DB
    try {
      const { rows } = await pool.query('SELECT * FROM ai_providers WHERE id = $1', [provider_id]);
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'Provider not found.' });
      const r = rows[0];
      config = {
        provider_type: r.provider_type,
        api_base_url: r.api_base_url.replace(/\/+$/, ''),
        api_key: r.api_key,
        model: r.model,
        max_tokens: 200,
        temperature: 0.3,
        extra_headers: r.extra_headers || {},
      };
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  } else {
    if (!provider_type || !api_base_url || !api_key || !model) {
      return res.status(400).json({ ok: false, error: 'Missing required fields.' });
    }
    config = {
      provider_type,
      api_base_url: api_base_url.replace(/\/+$/, ''),
      api_key,
      model,
      max_tokens: 200,
      temperature: 0.3,
      extra_headers: extra_headers || {},
    };
  }

  const testPrompt = 'Reply with exactly this JSON and nothing else: {"status":"ok","model":"' + config.model + '"}';

  try {
    const start = Date.now();
    let resp;

    if (config.provider_type === 'anthropic') {
      resp = await fetch(`${config.api_base_url}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': config.api_key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'User-Agent': 'siapstudi.com', ...config.extra_headers },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: testPrompt }], max_tokens: 200, temperature: 0.3 }),
      });
    } else if (config.provider_type === 'cloudflare_ai') {
      resp = await fetch(config.api_base_url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json', 'User-Agent': 'siapstudi.com', ...config.extra_headers },
        body: JSON.stringify({ model: config.model, input: { messages: [{ role: 'user', content: testPrompt }], max_tokens: 200, temperature: 0.3 } }),
      });
    } else {
      resp = await fetch(`${config.api_base_url}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json', 'User-Agent': 'siapstudi.com', ...config.extra_headers },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: testPrompt }], max_tokens: 200, temperature: 0.3 }),
      });
    }

    const durationMs = Date.now() - start;

    if (!resp.ok) {
      const errText = await resp.text();
      return res.json({ ok: false, error: `HTTP ${resp.status}: ${errText.slice(0, 300)}`, durationMs });
    }

    const data = await resp.json();
    let text = '';
    if (config.provider_type === 'anthropic') {
      text = (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    } else if (config.provider_type === 'cloudflare_ai') {
      const inner = data?.result?.result || data?.result || data;
      text = inner?.choices?.[0]?.message?.content || inner?.response || '';
    } else {
      text = data?.choices?.[0]?.message?.content || '';
    }

    return res.json({ ok: true, response: text.slice(0, 200), model: config.model, durationMs });
  } catch (err) {
    return res.json({ ok: false, error: err.message, model: config.model });
  }
});

module.exports = router;
