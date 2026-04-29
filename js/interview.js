// Interview simulator — generates personalized questions from essay

(function () {
  const el = (id) => document.getElementById(id);
  const state = {
    questions: [],
    answers: [],
    audioBlobs: [],       // per-question audio blob URL
    idx: 0,
    startTime: 0,
    timerId: null,
    essay: '',
    lang: 'id-ID',
    perQuestionSec: 90,
    paused: false,
    pauseStart: 0,
    finished: false,
  };
  // Per-question countdown
  const qTimer = {
    intervalId: null,
    remaining: 0,
    total: 0,
  };
  const media = {
    stream: null,
    recorder: null,
    chunks: [],
    recording: false,
    recStart: 0,
    recTimerId: null,
    recognition: null,
    recognitionActive: false,
    baseText: '',         // text in textarea before live transcript starts
  };

  const essayInput = el('essayInput');
  const wc = el('wordCount');
  essayInput.addEventListener('input', () => {
    wc.textContent = essayInput.value.trim() ? essayInput.value.trim().split(/\s+/).length : 0;
  });

  // Load saved essay if exists
  const saved = App.getEssay();
  if (saved) { essayInput.value = saved; wc.textContent = saved.trim().split(/\s+/).length; }

  // ---------- AI settings (key persisted in localStorage) ----------
  const AI_KEY_STORE = 'lpdp_anthropic_key';
  const AI_MODEL_STORE = 'lpdp_anthropic_model';
  const AI_TEMP_STORE = 'lpdp_anthropic_temp';
  const AI_ENABLE_STORE = 'lpdp_ai_enabled';

  const aiEnable = el('aiEnable');
  const aiFields = el('aiFields');
  const aiKey = el('aiKey');
  const aiModel = el('aiModel');
  const aiTemp = el('aiTemp');
  const aiStatus = el('aiStatus');
  const aiRefCount = el('aiRefCount');

  // Restore saved AI prefs
  try {
    aiKey.value = localStorage.getItem(AI_KEY_STORE) || '';
    const m = localStorage.getItem(AI_MODEL_STORE); if (m) aiModel.value = m;
    const t = localStorage.getItem(AI_TEMP_STORE); if (t) aiTemp.value = t;
    aiEnable.checked = localStorage.getItem(AI_ENABLE_STORE) === '1';
  } catch {}
  aiFields.classList.toggle('hidden', !aiEnable.checked);

  aiEnable.addEventListener('change', () => {
    aiFields.classList.toggle('hidden', !aiEnable.checked);
    localStorage.setItem(AI_ENABLE_STORE, aiEnable.checked ? '1' : '0');
  });
  aiKey.addEventListener('change', () => localStorage.setItem(AI_KEY_STORE, aiKey.value.trim()));
  aiModel.addEventListener('change', () => localStorage.setItem(AI_MODEL_STORE, aiModel.value));
  aiTemp.addEventListener('change', () => localStorage.setItem(AI_TEMP_STORE, aiTemp.value));

  // Show how many reference questions are available
  (async () => {
    try {
      const refs = await App.fetchReferenceQuestions();
      aiRefCount.textContent = refs.length + ' pertanyaan referensi tersedia';
    } catch {}
  })();

  function setAiStatus(msg, kind) {
    aiStatus.className = 'ai-status' + (kind ? ' ' + kind : '');
    aiStatus.textContent = msg || '';
  }

  // ---------- Claude API call ----------
  async function callClaude({ apiKey, model, temperature, system, user }) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        temperature,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch {}
      throw new Error('Claude API ' + res.status + (detail ? ': ' + detail : ''));
    }
    const data = await res.json();
    return (data.content || []).map(c => c.text || '').join('\n').trim();
  }

  // Robust JSON-array extractor: tolerates code fences and prose around the array.
  function extractJsonArray(text) {
    if (!text) return null;
    // Strip ```json fences
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(candidate.slice(start, end + 1)); }
    catch { return null; }
  }

  async function generateQuestionsWithAI({ essay, n, lang, refs, apiKey, model, temperature }) {
    const allowedFoci = ['Clarity', 'Motivation', 'Confidence', 'Alignment', 'Impact', 'Relevance'];
    const langName = lang === 'en' ? 'English' : 'Bahasa Indonesia';
    const langInstr = lang === 'en'
      ? 'Write every question in fluent, natural English.'
      : 'Tulis setiap pertanyaan dalam Bahasa Indonesia yang natural dan tajam (gunakan "kamu" / "Anda" konsisten).';

    const refList = (refs || []).slice(0, 25).map((r, i) =>
      `${i + 1}. [${r.focus || '?'}] ${r.question}${r.notes ? '  (catatan: ' + r.notes + ')' : ''}`
    ).join('\n');

    const system = [
      'You are a senior LPDP scholarship interviewer in Indonesia.',
      'Your job is to read an applicant\'s essay and produce sharp, personalized interview questions that probe weaknesses, hidden assumptions, vague claims, timeline issues, motivation gaps, and contribution-vs-feasibility tensions specific to THIS candidate.',
      'Avoid generic questions that could apply to anyone — every question must reference something concrete from the essay.',
      'Mix question types: at least one introduction question, one motivation question, several essay-specific challenges (probing weak claims, missing numbers, timeline gaps), one return-to-Indonesia / contribution question, one curveball.',
      'Each question must include a "focus" tag from this exact set: ' + allowedFoci.join(', ') + '.',
      langInstr,
      'Return ONLY a JSON array. No commentary, no markdown fences. Format: [{"q": "...", "focus": "Motivation"}, ...].',
    ].join(' ');

    const user = [
      'REFERENCE QUESTIONS (use as inspiration for tone, depth, and follow-up style — do NOT copy verbatim):',
      refList || '(no reference questions provided yet — rely on best practices for LPDP interviews)',
      '',
      'CANDIDATE ESSAY:',
      '"""',
      essay,
      '"""',
      '',
      `Generate exactly ${n} interview questions in ${langName}, personalized to the essay above.`,
      'Return JSON only.',
    ].join('\n');

    const raw = await callClaude({ apiKey, model, temperature, system, user });
    const arr = extractJsonArray(raw);
    if (!Array.isArray(arr) || !arr.length) {
      throw new Error('AI tidak mengembalikan JSON yang valid.');
    }
    return arr.map(item => ({
      q: String(item.q || item.question || '').trim(),
      focus: allowedFoci.includes(item.focus) ? item.focus : 'Clarity',
    })).filter(x => x.q.length > 8).slice(0, n);
  }

  // --- Question generation based on essay content ---
  function detectTopics(essay) {
    const lower = essay.toLowerCase();
    const topics = {
      hasDegree: /(master|s2|magister|phd|doktor|s3|doctorate|doctoral|graduate)/i.test(essay),
      hasUniv: /(universitas|university|institut|institute|college|school of|tu delft|mit|harvard|oxford|cambridge|ntu|nus|unsw|nottingham)/i.test(essay),
      univMatch: (essay.match(/(universitas[^,\.\n]{0,40}|[A-Z][a-z]+ University|University of [A-Z][a-z]+|TU [A-Z][a-z]+)/) || [])[0],
      hasLedProject: /(memimpin|mengorganisir|founding|founder|ketua|inisiator|mendirikan|\bled\b|leading|chaired|organized|organised|initiated|co-founded)/i.test(lower),
      hasPublication: /(publikasi|jurnal|paper|riset|research|journal|published|publication)/i.test(lower),
      hasVillage: /(desa|pedesaan|daerah tertinggal|\b3t\b|village|rural|remote area|underserved|underdeveloped)/i.test(lower),
      hasTech: /(teknologi|technology|\bai\b|machine learning|software|aplikasi|application|digital|\bdata\b|algorithm)/i.test(lower),
      hasHealth: /(kesehatan|medis|dokter|rumah sakit|gizi|stunting|health|medical|doctor|hospital|nutrition|public health)/i.test(lower),
      hasEnv: /(lingkungan|iklim|sampah|energi|hutan|air|sanitasi|environment|climate|waste|energy|forest|water|sanitation|sustainability)/i.test(lower),
      hasEdu: /(pendidikan|sekolah|guru|literasi|kurikulum|education|school|teacher|literacy|curriculum|pedagogy)/i.test(lower),
      hasBusiness: /(bisnis|wirausaha|startup|umkm|ekonomi|business|entrepreneur|entrepreneurship|\bsme\b|economy|economic)/i.test(lower),
      hasSocial: /(sosial|komunitas|pemberdayaan|relawan|volunteer|social|community|empowerment|ngo|non-profit)/i.test(lower),
      returnPlan: /(kembali ke indonesia|pulang ke indonesia|setelah lulus|pasca studi|return to indonesia|come back to indonesia|after graduation|upon returning)/i.test(lower),
      mentionLPDP: /lpdp/i.test(lower),
      numbers: (essay.match(/\b\d+[\d.,]*\b/g) || []),
    };
    return topics;
  }

  function generateQuestions(essay, n, lang) {
    const t = detectTopics(essay);
    const pool = [];
    const isEn = lang === 'en';
    // Localize helper
    const L = (id, en) => isEn ? en : id;

    // Core questions (always relevant)
    pool.push({
      q: L(
        'Silakan perkenalkan diri Anda secara singkat dan jelaskan mengapa Anda mendaftar beasiswa LPDP.',
        'Please briefly introduce yourself and explain why you are applying for the LPDP scholarship.'
      ),
      focus: 'Clarity'
    });
    pool.push({
      q: L(
        'Apa motivasi utama Anda untuk melanjutkan studi ke jenjang yang lebih tinggi saat ini?',
        'What is your main motivation for pursuing graduate studies at this point in your life?'
      ),
      focus: 'Motivation'
    });

    // Personalized based on detected topics
    if (t.hasUniv && t.univMatch) {
      const uni = t.univMatch.trim();
      pool.push({
        q: L(
          `Anda menyebut ${uni} sebagai tujuan studi. Mengapa Anda memilih universitas tersebut, dan apa keunggulan program di sana dibanding alternatif lain?`,
          `You mentioned ${uni} as your target university. Why did you choose it, and what makes its program better than the alternatives you considered?`
        ),
        focus: 'Alignment'
      });
    } else {
      pool.push({
        q: L(
          'Universitas apa yang menjadi tujuan studi Anda, dan apa alasan spesifik pemilihan universitas tersebut?',
          'Which university is your target, and what are the specific reasons behind that choice?'
        ),
        focus: 'Alignment'
      });
    }

    if (t.hasLedProject) {
      pool.push({
        q: L(
          'Ceritakan pengalaman kepemimpinan yang paling berkesan. Tantangan apa yang Anda hadapi dan bagaimana Anda menyelesaikannya?',
          'Tell me about your most memorable leadership experience. What challenges did you face and how did you overcome them?'
        ),
        focus: 'Impact'
      });
    }
    if (t.hasVillage) {
      pool.push({
        q: L(
          'Anda menyinggung pengalaman atau rencana di daerah pedesaan/tertinggal. Bagaimana strategi konkret Anda agar program tersebut berkelanjutan setelah Anda tidak lagi terlibat?',
          'You mentioned work or plans in rural / underserved areas. What is your concrete strategy to keep such a program sustainable after you are no longer involved?'
        ),
        focus: 'Impact'
      });
    }
    if (t.hasTech) {
      pool.push({
        q: L(
          'Bagaimana Anda memastikan solusi berbasis teknologi yang Anda rencanakan dapat diakses dan diterima oleh masyarakat yang mungkin belum literate teknologi?',
          'How will you make sure your technology-based solution is accessible and accepted by communities that may not be tech-literate?'
        ),
        focus: 'Impact'
      });
    }
    if (t.hasHealth) {
      pool.push({
        q: L(
          'Di bidang kesehatan, seberapa kritiskah isu yang Anda soroti di Indonesia? Apa kontribusi spesifik yang ingin Anda berikan?',
          'How critical is the health issue you highlighted for Indonesia, and what is the specific contribution you intend to make?'
        ),
        focus: 'Relevance'
      });
    }
    if (t.hasEnv) {
      pool.push({
        q: L(
          'Isu lingkungan sering berbenturan dengan kepentingan ekonomi. Bagaimana Anda akan menjembatani tantangan ini di level kebijakan maupun implementasi?',
          'Environmental issues often clash with economic interests. How will you bridge this tension at both the policy and implementation level?'
        ),
        focus: 'Impact'
      });
    }
    if (t.hasEdu) {
      pool.push({
        q: L(
          'Apa masalah paling mendesak di sektor pendidikan Indonesia menurut Anda, dan bagaimana studi Anda akan berkontribusi menjawab masalah itu?',
          'What is the most pressing problem in Indonesian education in your view, and how will your studies help address it?'
        ),
        focus: 'Relevance'
      });
    }
    if (t.hasBusiness) {
      pool.push({
        q: L(
          'Bagaimana studi Anda akan membantu mengembangkan ekosistem wirausaha atau UMKM di Indonesia secara konkret?',
          'How will your studies concretely help develop Indonesia\'s entrepreneurship or SME ecosystem?'
        ),
        focus: 'Impact'
      });
    }
    if (t.returnPlan) {
      pool.push({
        q: L(
          'Anda menyatakan akan kembali ke Indonesia. Apa rencana 3 tahun pertama Anda setelah lulus — lembaga, peran, dan target spesifik?',
          'You mentioned you will return to Indonesia. What is your plan for the first three years after graduation — which institution, role, and specific targets?'
        ),
        focus: 'Alignment'
      });
    } else {
      pool.push({
        q: L(
          'LPDP mensyaratkan kembali ke Indonesia. Apa rencana kontribusi spesifik Anda setelah menyelesaikan studi?',
          'LPDP requires awardees to return to Indonesia. What is your specific contribution plan after completing your studies?'
        ),
        focus: 'Alignment'
      });
    }
    if (t.numbers.length < 2) {
      pool.push({
        q: L(
          'Jika memungkinkan, sebutkan angka atau target terukur yang ingin Anda capai dari rencana kontribusi Anda.',
          'If possible, share measurable numbers or targets you want to reach through your contribution plan.'
        ),
        focus: 'Impact'
      });
    }

    // Always include these critical LPDP questions
    pool.push({
      q: L(
        'Apa kelemahan atau kekurangan terbesar Anda, dan bagaimana Anda mengatasinya selama ini?',
        'What is your biggest weakness, and how have you been working on it?'
      ),
      focus: 'Confidence'
    });
    pool.push({
      q: L(
        'Bagaimana Anda akan memanfaatkan jaringan alumni LPDP untuk mencapai tujuan kontribusi Anda?',
        'How will you leverage the LPDP alumni network to achieve your contribution goals?'
      ),
      focus: 'Alignment'
    });
    pool.push({
      q: L(
        'Jika tidak lolos beasiswa LPDP, apa rencana Anda selanjutnya?',
        'If you do not receive the LPDP scholarship, what is your backup plan?'
      ),
      focus: 'Confidence'
    });
    pool.push({
      q: L(
        'Apa nilai LPDP (integritas, profesional, visioner, sinergi) yang paling resonan dengan Anda, dan berikan contoh nyata penerapannya dalam hidup Anda.',
        'Which LPDP value (integrity, professionalism, vision, synergy) resonates most with you? Give a concrete example of how you have lived it out.'
      ),
      focus: 'Relevance'
    });
    pool.push({
      q: L(
        'Bagaimana Anda menjaga keseimbangan antara tekanan akademik dan kondisi mental saat studi di luar negeri?',
        'How will you balance academic pressure and mental wellbeing while studying abroad?'
      ),
      focus: 'Confidence'
    });

    // Shuffle middle, keep intro first
    const intro = pool.slice(0, 1);
    const rest = pool.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    return [...intro, ...rest].slice(0, n);
  }

  el('startInterviewBtn').addEventListener('click', async () => {
    const essay = essayInput.value.trim();
    const words = essay ? essay.split(/\s+/).length : 0;
    if (words < 100) {
      alert('Essay terlalu pendek. Minimal 100 kata untuk membuat pertanyaan yang relevan.');
      return;
    }
    state.essay = essay;
    App.saveEssay(essay);
    const n = parseInt(el('interviewLength').value, 10);
    state.lang = el('interviewLang').value || 'id-ID';
    const shortLang = state.lang.startsWith('en') ? 'en' : 'id';
    state.shortLang = shortLang;
    state.perQuestionSec = parseInt(el('perQuestionSec').value, 10) || 90;

    const startBtn = el('startInterviewBtn');
    const useAI = aiEnable.checked && (aiKey.value || '').trim().length > 10;

    if (useAI) {
      startBtn.disabled = true;
      startBtn.textContent = 'AI sedang membuat pertanyaan...';
      setAiStatus('Mengambil pertanyaan referensi & memanggil model...', '');
      try {
        const refs = await App.fetchReferenceQuestions(shortLang);
        const apiKey = (aiKey.value || '').trim();
        const model = aiModel.value;
        const temperature = parseFloat(aiTemp.value) || 0.7;
        const aiQuestions = await generateQuestionsWithAI({
          essay, n, lang: shortLang, refs, apiKey, model, temperature
        });
        if (aiQuestions.length < Math.max(3, Math.floor(n / 2))) {
          throw new Error('Jumlah pertanyaan dari AI terlalu sedikit.');
        }
        state.questions = aiQuestions;
        state.aiUsed = true;
        setAiStatus(`✓ ${aiQuestions.length} pertanyaan dibuat oleh ${model} berdasarkan ${refs.length} referensi.`, 'success');
      } catch (err) {
        console.warn('AI question gen failed:', err);
        setAiStatus('⚠ ' + (err?.message || err) + ' — pakai pertanyaan rule-based.', 'error');
        state.questions = generateQuestions(essay, n, shortLang);
        state.aiUsed = false;
      } finally {
        startBtn.disabled = false;
        startBtn.textContent = 'Lanjut ke Pengecekan Kamera →';
      }
    } else {
      state.questions = generateQuestions(essay, n, shortLang);
      state.aiUsed = false;
    }

    state.answers = new Array(state.questions.length).fill('');
    state.audioBlobs = new Array(state.questions.length).fill(null);
    state.idx = 0;

    // Move to media setup stage
    el('essayStage').classList.add('hidden');
    el('mediaStage').classList.remove('hidden');
    requestMedia();
  });

  // --- Media setup (camera + mic) ---
  async function requestMedia() {
    const statusEl = el('mediaStatus');
    const errorEl = el('mediaError');
    const beginBtn = el('beginInterviewBtn');
    errorEl.classList.add('hidden');
    errorEl.innerHTML = '';
    statusEl.textContent = 'Meminta izin kamera & mikrofon...';
    beginBtn.disabled = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      errorEl.classList.remove('hidden');
      errorEl.innerHTML = '<div class="alert alert-error">Browser ini tidak mendukung akses kamera/mikrofon. Kamu masih bisa menjawab secara tertulis.</div>';
      statusEl.textContent = 'Tidak tersedia';
      return;
    }

    try {
      // Stop any previous stream
      stopMediaStream();
      media.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const preview = el('mediaPreview');
      preview.srcObject = media.stream;
      statusEl.textContent = 'Kamera & mikrofon aktif ✓';
      beginBtn.disabled = false;
    } catch (err) {
      console.warn('getUserMedia error:', err);
      errorEl.classList.remove('hidden');
      const msg = err && err.name === 'NotAllowedError'
        ? 'Akses ditolak. Izinkan kamera & mikrofon di pengaturan browser, lalu klik "Coba Izinkan Lagi", atau lewati untuk jawab tulisan saja.'
        : (err && err.name === 'NotFoundError'
            ? 'Tidak ada kamera atau mikrofon yang terdeteksi di perangkat ini.'
            : 'Gagal mengakses kamera/mikrofon: ' + (err?.message || err));
      errorEl.innerHTML = '<div class="alert alert-error">' + escapeHtml(msg) + '</div>';
      statusEl.textContent = 'Tidak dapat mengakses media';
    }
  }

  function stopMediaStream() {
    // Tear down recognizer + recorder so they can be re-initialized next session
    media.recognitionActive = false;
    if (media.recognition) {
      try { media.recognition.onend = null; media.recognition.stop(); } catch {}
      media.recognition = null;
    }
    if (media.recorder) {
      try { if (media.recorder.state !== 'inactive') media.recorder.stop(); } catch {}
      media.recorder = null;
    }
    media.audioStream = null;
    media.chunks = [];
    if (media.stream) {
      media.stream.getTracks().forEach(t => t.stop());
      media.stream = null;
    }
  }

  el('retryMediaBtn').addEventListener('click', requestMedia);

  el('skipMediaBtn').addEventListener('click', () => {
    stopMediaStream();
    startInterviewFlow(false);
  });

  el('beginInterviewBtn').addEventListener('click', () => {
    startInterviewFlow(!!media.stream);
  });

  function startInterviewFlow(useMedia) {
    state.startTime = Date.now();
    state.finished = false;
    state.paused = false;
    el('mediaStage').classList.add('hidden');
    el('interviewStage').classList.remove('hidden');
    state.useMedia = !!(useMedia && media.stream);

    if (state.useMedia) {
      const pip = el('cameraPip');
      const pipVid = el('cameraPipVideo');
      pipVid.srcObject = media.stream;
      pip.classList.remove('hidden');
      el('recLive').classList.remove('hidden');
      el('iAnswerHint').textContent = '(terisi otomatis dari suara — kamu juga bisa mengetik/mengedit)';
    } else {
      el('cameraPip').classList.add('hidden');
      el('recLive').classList.add('hidden');
      el('iAnswerHint').textContent = '(mode tulisan — timer tetap berjalan, jawab secepat mungkin)';
    }

    renderQ();
    startTimer();
  }

  function startTimer() {
    state.timerId = setInterval(() => {
      if (state.paused) return;
      const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      el('iTimer').textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }, 1000);
  }

  function renderQ() {
    // Stop any ongoing recording and per-question timer when transitioning
    stopQuestionTimer();
    if (media.recording) stopRecording(true);

    const q = state.questions[state.idx];
    const isEn = state.shortLang === 'en';
    const L = (id, en) => isEn ? en : id;
    el('iQnum').textContent = L('Pertanyaan ', 'Question ') + (state.idx + 1) + L(' dari ', ' of ') + state.questions.length + ' • ' + L('Fokus', 'Focus') + ': ' + focusLabel(q.focus);
    el('iQtext').textContent = q.q;
    const ans = el('iAnswer');
    ans.value = state.answers[state.idx] || '';
    updateWordCount();
    el('iNumLabel').textContent = '• ' + (state.idx + 1) + '/' + state.questions.length;
    el('iProgress').style.width = ((state.idx + 1) / state.questions.length * 100) + '%';
    el('iSkipBtn').textContent = state.idx === state.questions.length - 1
      ? L('Selesai Sekarang →', 'Finish Now →')
      : L('Lewati Pertanyaan →', 'Skip Question →');

    // Reset playback UI
    const playback = el('recPlayback');
    playback.removeAttribute('src');
    playback.classList.add('hidden');

    renderChat();

    // Auto-start per-question countdown + recording
    startQuestionTimer(state.perQuestionSec);
    if (state.useMedia && !state.paused) {
      startRecording();
    } else if (!state.useMedia) {
      el('recStatus').textContent = 'Mode tulisan — ketik jawaban sebelum waktu habis';
    }
  }
  function updateWordCount() {
    const t = el('iAnswer').value.trim();
    el('iWords').textContent = t ? t.split(/\s+/).length : 0;
  }
  el('iAnswer').addEventListener('input', () => {
    state.answers[state.idx] = el('iAnswer').value;
    updateWordCount();
  });

  function renderChat() {
    const chat = el('chatView');
    chat.innerHTML = '';
    const isEn = state.shortLang === 'en';
    const interviewerLabel = isEn ? 'Interviewer' : 'Pewawancara';
    const youLabel = isEn ? 'You' : 'Kamu';
    for (let i = 0; i <= state.idx; i++) {
      const qBubble = document.createElement('div');
      qBubble.className = 'bubble bubble-q';
      qBubble.innerHTML = `<small>${interviewerLabel}</small>` + escapeHtml(state.questions[i].q);
      chat.appendChild(qBubble);
      if (state.answers[i]) {
        const aBubble = document.createElement('div');
        aBubble.className = 'bubble bubble-a';
        aBubble.innerHTML = `<small>${youLabel}</small>` + escapeHtml(state.answers[i]);
        chat.appendChild(aBubble);
      }
    }
    chat.scrollTop = chat.scrollHeight;
  }

  function advanceQuestion() {
    if (state.finished) return;
    // Finalize recording (stops recorder -> will save blob to current idx)
    if (media.recording) stopRecording(true);
    stopQuestionTimer();

    if (state.idx === state.questions.length - 1) {
      finish();
    } else {
      state.idx++;
      renderQ();
    }
  }

  el('iSkipBtn').addEventListener('click', () => {
    if (state.paused) togglePause(); // resume first so recording saves cleanly
    advanceQuestion();
  });

  el('iPauseBtn').addEventListener('click', togglePause);

  // --- Audio recording + speech recognition ---
  function setRecButtonState(isRecording) {
    const dot = el('cameraPipDot');
    if (dot) dot.classList.toggle('live', !!isRecording);
    const status = el('recStatus');
    if (status) {
      const isEn = state.shortLang === 'en';
      status.textContent = isRecording
        ? (isEn ? 'Recording...' : 'Merekam...')
        : (state.audioBlobs[state.idx]
            ? (isEn ? 'Recording saved' : 'Rekaman tersimpan')
            : (isEn ? 'Ready' : 'Siap'));
    }
  }

  function startRecTimer() {
    media.recStart = Date.now();
    el('recTime').textContent = '00:00';
    media.recTimerId = setInterval(() => {
      const s = Math.floor((Date.now() - media.recStart) / 1000);
      el('recTime').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 500);
  }
  function stopRecTimer() {
    if (media.recTimerId) { clearInterval(media.recTimerId); media.recTimerId = null; }
  }

  // Initialize MediaRecorder + SpeechRecognition ONCE from the persistent stream.
  // Reusing the same instances across questions avoids re-prompting the user
  // for microphone permission on each "skip" / question transition.
  function initMediaPipeline() {
    if (!media.stream) return false;
    const audioTracks = media.stream.getAudioTracks();
    if (!audioTracks.length) return false;

    // --- MediaRecorder (created once) ---
    if (!media.recorder) {
      if (!media.audioStream) media.audioStream = new MediaStream(audioTracks);
      try {
        const mime = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
        media.recorder = mime
          ? new MediaRecorder(media.audioStream, { mimeType: mime })
          : new MediaRecorder(media.audioStream);
      } catch (err) {
        console.warn('MediaRecorder init failed:', err);
        return false;
      }

      media.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) media.chunks.push(e.data);
      };
      media.recorder.onstop = () => {
        if (!media.chunks.length) { media.pendingSaveIdx = null; return; }
        const blob = new Blob(media.chunks, { type: media.recorder.mimeType || 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const idx = (media.pendingSaveIdx != null) ? media.pendingSaveIdx : state.idx;
        const prev = state.audioBlobs[idx];
        if (prev) URL.revokeObjectURL(prev);
        state.audioBlobs[idx] = url;

        // Only update playback UI if we're still showing that question
        if (idx === state.idx) {
          const playback = el('recPlayback');
          playback.src = url;
          playback.classList.remove('hidden');
          el('recStatus').textContent = 'Rekaman selesai';
        }
        media.chunks = [];
        media.pendingSaveIdx = null;
      };
    }

    // --- SpeechRecognition (created once) ---
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR && !media.recognition) {
      try {
        const rec = new SR();
        rec.lang = state.lang || 'id-ID';
        rec.continuous = true;
        rec.interimResults = true;

        rec.onresult = (ev) => {
          let interim = '';
          let finalAdd = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i];
            if (r.isFinal) finalAdd += r[0].transcript + ' ';
            else interim += r[0].transcript;
          }
          if (finalAdd) media.baseText += finalAdd;
          const ta = el('iAnswer');
          ta.value = (media.baseText + interim).replace(/\s+/g, ' ').trim();
          state.answers[state.idx] = ta.value;
          updateWordCount();
        };
        rec.onerror = (e) => {
          console.warn('Speech recognition error:', e.error);
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            el('recStatus').textContent = 'Transkripsi tidak diizinkan — suara tetap direkam.';
          }
        };
        rec.onend = () => {
          // Restart only if we're still in an active "should be listening" state
          // (Chrome naturally ends recognition after silence — keep it alive).
          if (media.recognitionActive && !state.paused) {
            // Small delay avoids InvalidStateError race
            setTimeout(() => {
              if (media.recognitionActive && !state.paused) {
                try { rec.start(); } catch (err) { /* ignore */ }
              }
            }, 50);
          }
        };
        media.recognition = rec;
      } catch (err) {
        console.warn('SpeechRecognition init failed:', err);
      }
    }

    return true;
  }

  function startRecognition() {
    if (!media.recognition) return false;
    // Seed baseText with existing textarea value so typed edits aren't clobbered
    media.baseText = el('iAnswer').value;
    if (media.baseText && !media.baseText.endsWith(' ')) media.baseText += ' ';
    media.recognitionActive = true;
    try {
      media.recognition.start();
    } catch (err) {
      // InvalidStateError = already started → fine
      if (err && err.name !== 'InvalidStateError') console.warn('rec.start error:', err);
    }
    return true;
  }

  function stopRecognition() {
    media.recognitionActive = false;
    if (media.recognition) {
      try { media.recognition.stop(); } catch {}
    }
  }

  function startRecording() {
    if (!media.stream) {
      alert('Kamera/mikrofon belum aktif. Izinkan akses di langkah sebelumnya atau gunakan mode tulisan.');
      return;
    }
    if (media.recording) return;

    if (!initMediaPipeline() || !media.recorder) {
      el('recStatus').textContent = 'Perekaman tidak tersedia di browser ini';
      return;
    }

    // Fresh chunks for this question's recording
    media.chunks = [];
    try {
      if (media.recorder.state === 'inactive') {
        media.recorder.start(250);
      } else if (media.recorder.state === 'paused') {
        media.recorder.resume();
      }
    } catch (err) {
      console.warn('recorder.start failed:', err);
      return;
    }

    media.recording = true;
    setRecButtonState(true);
    const isEn = state.shortLang === 'en';
    el('recStatus').textContent = isEn ? 'Recording...' : 'Merekam...';
    startRecTimer();

    const ok = startRecognition();
    if (!ok || !media.recognition) {
      el('recStatus').textContent = isEn
        ? 'Recording (auto-transcription not supported by this browser — type manually)'
        : 'Merekam (transkripsi otomatis tidak didukung browser — ketik manual)';
    }
  }

  function stopRecording(silent) {
    if (!media.recording) return;
    media.recording = false;
    stopRecognition();
    // Tag which question slot this recording belongs to BEFORE stopping,
    // because onstop fires asynchronously and state.idx may advance by then.
    media.pendingSaveIdx = state.idx;
    try {
      if (media.recorder && media.recorder.state !== 'inactive') media.recorder.stop();
    } catch (err) {
      console.warn('stopRecording error:', err);
    }
    if (silent) {
      setRecButtonState(false);
      stopRecTimer();
    }
  }

  // --- Per-question countdown timer ---
  function startQuestionTimer(sec) {
    stopQuestionTimer();
    qTimer.total = sec;
    qTimer.remaining = sec;
    updateCountdownDisplay();
    qTimer.intervalId = setInterval(() => {
      if (state.paused) return;
      qTimer.remaining -= 1;
      updateCountdownDisplay();
      if (qTimer.remaining <= 0) {
        advanceQuestion();
      }
    }, 1000);
  }

  function stopQuestionTimer() {
    if (qTimer.intervalId) {
      clearInterval(qTimer.intervalId);
      qTimer.intervalId = null;
    }
  }

  const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // matches <circle r="52">

  function updateCountdownDisplay() {
    const sec = Math.max(0, qTimer.remaining);
    const valueEl = el('qCountdownValue');
    if (valueEl) valueEl.textContent = sec;
    const labelEl = document.querySelector('.q-countdown-label');
    if (labelEl) labelEl.textContent = state.shortLang === 'en' ? 'seconds' : 'detik';
    const ring = el('qRingFg');
    if (ring) {
      const pct = qTimer.total > 0 ? sec / qTimer.total : 0;
      ring.style.strokeDasharray = RING_CIRCUMFERENCE.toFixed(2);
      ring.style.strokeDashoffset = (RING_CIRCUMFERENCE * (1 - pct)).toFixed(2);
      // Color shifts: blue -> amber (≤15s) -> red (≤5s)
      ring.classList.toggle('warn', sec <= 15 && sec > 5);
      ring.classList.toggle('danger', sec <= 5);
    }
  }

  // --- Pause / resume everything ---
  function togglePause() {
    if (state.finished) return;
    if (!state.paused) {
      state.paused = true;
      state.pauseStart = Date.now();
      // Pause total timer by adjusting startTime on resume (handled below)
      // Pause recorder
      if (media.recorder && media.recorder.state === 'recording') {
        try { media.recorder.pause(); } catch {}
      }
      stopRecognition(); // speech API can't pause; restart on resume
      const isEn = state.shortLang === 'en';
      el('iPauseBtn').textContent = isEn ? '▶ Resume' : '▶ Lanjutkan';
      el('cameraPipPaused')?.classList.add('show');
      el('interviewStage').classList.add('paused');
      el('recStatus').textContent = isEn
        ? 'Paused — recording & timer stopped'
        : 'Dijeda — rekaman & timer berhenti';
    } else {
      // Resume
      const pausedMs = Date.now() - state.pauseStart;
      state.startTime += pausedMs; // shift baseline so total timer doesn't jump
      state.paused = false;
      if (media.recorder && media.recorder.state === 'paused') {
        try { media.recorder.resume(); } catch {}
      }
      if (state.useMedia && media.recorder && media.recorder.state === 'recording') {
        startRecognition();
      }
      const isEn2 = state.shortLang === 'en';
      el('iPauseBtn').textContent = isEn2 ? '⏸ Pause' : '⏸ Jeda';
      el('cameraPipPaused')?.classList.remove('show');
      el('interviewStage').classList.remove('paused');
      el('recStatus').textContent = media.recording
        ? (isEn2 ? 'Recording...' : 'Merekam...')
        : (isEn2 ? 'Ready' : 'Siap');
    }
  }

  // Bind spacebar to pause when on interview stage
  document.addEventListener('keydown', (e) => {
    if (e.target && ['TEXTAREA', 'INPUT', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'Space' && !el('interviewStage').classList.contains('hidden')) {
      e.preventDefault();
      togglePause();
    }
  });

  // --- Evaluation ---
  function evaluateAnswer(q, ans) {
    const text = (ans || '').trim();
    const words = text ? text.split(/\s+/).length : 0;
    const isEn = state.shortLang === 'en';
    const L = (id, en) => isEn ? en : id;

    if (!text) return { score: 0, notes: [L('Tidak dijawab.', 'Not answered.')] };

    let score = 50;
    const notes = [];

    // Length
    if (words >= 80 && words <= 220) { score += 15; }
    else if (words < 40) {
      score -= 15;
      notes.push(L('Jawaban terlalu pendek — perluas dengan contoh konkret.',
                   'Answer is too short — expand with concrete examples.'));
    } else if (words > 280) {
      score -= 5;
      notes.push(L('Jawaban cukup panjang — pastikan tetap fokus.',
                   'Answer is a bit long — make sure it stays focused.'));
    }

    // Structure cues (STAR, examples)
    const exampleRe = /(contoh|misalnya|saat itu|waktu itu|pada saat|for example|for instance|once|during|when i|i remember)/i;
    if (exampleRe.test(text)) score += 8;
    else notes.push(L('Gunakan contoh konkret dari pengalamanmu.',
                      'Use a concrete example from your experience.'));

    // Numbers / specifics
    if (/\b\d+/.test(text)) score += 8;
    else if (q.focus === 'Impact') {
      notes.push(L('Sertakan angka atau target terukur untuk memperkuat dampak.',
                   'Include numbers or measurable targets to strengthen impact.'));
    }

    // Confidence words
    const confRe = /\b(saya yakin|saya percaya|saya berkomitmen|saya siap|i am confident|i believe|i am committed|i am ready|i'm confident|i'm committed|i'm ready)\b/i;
    if (confRe.test(text)) score += 5;
    const hedgeRe = /\b(mungkin|sepertinya|agak|ragu|kira-kira|maybe|probably|kind of|sort of|i guess|i'm not sure|roughly|perhaps)\b/i;
    if (hedgeRe.test(text)) {
      score -= 8;
      notes.push(L('Hindari kata ragu ("mungkin", "agak"). Gunakan bahasa tegas.',
                   'Avoid hedging words ("maybe", "kind of"). Use assertive language.'));
    }

    // Focus-specific
    if (q.focus === 'Alignment' && !/(indonesia|kontribusi|kembali|contribution|\breturn\b|come back)/i.test(text)) {
      score -= 10;
      notes.push(L('Kaitkan jawaban dengan kontribusi untuk Indonesia.',
                   'Tie your answer to a concrete contribution to Indonesia.'));
    }
    if (q.focus === 'Relevance' && !/(lpdp|nilai|integritas|profesional|visioner|sinergi|integrity|professional|visionary|synergy|values)/i.test(text)) {
      score -= 5;
    }

    score = Math.max(0, Math.min(100, score));
    return { score, notes, words };
  }

  function finish() {
    state.finished = true;
    if (state.timerId) clearInterval(state.timerId);
    stopQuestionTimer();
    // Stop any ongoing recording & release camera/mic
    if (media.recording) stopRecording(true);
    stopMediaStream();
    el('cameraPip').classList.add('hidden');
    el('interviewStage').classList.remove('paused');
    const evals = state.questions.map((q, i) => ({ q, ans: state.answers[i], eval: evaluateAnswer(q, state.answers[i]) }));
    const answered = evals.filter(e => e.ans && e.ans.trim().length > 20);
    const overall = answered.length
      ? Math.round(answered.reduce((s, e) => s + e.eval.score, 0) / answered.length)
      : 0;

    // Category breakdown (by focus)
    const byFocus = {};
    evals.forEach(e => {
      const k = e.q.focus;
      if (!byFocus[k]) byFocus[k] = { total: 0, count: 0 };
      byFocus[k].total += e.eval.score;
      byFocus[k].count++;
    });
    const focusScores = {};
    Object.keys(byFocus).forEach(k => focusScores[k] = Math.round(byFocus[k].total / byFocus[k].count));

    // Aggregate strengths/weaknesses/suggestions
    const allNotes = evals.flatMap(e => e.eval.notes);
    const noteCount = {};
    allNotes.forEach(n => noteCount[n] = (noteCount[n] || 0) + 1);
    const topIssues = Object.entries(noteCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);

    const strengths = [];
    const weaknesses = [];
    const suggestions = [];
    const isEn = state.shortLang === 'en';
    const L = (id, en) => isEn ? en : id;

    if (overall >= 75) strengths.push(L(
      'Jawaban secara keseluruhan solid, jelas, dan percaya diri.',
      'Answers are solid, clear, and confident overall.'));
    if (answered.length === evals.length) strengths.push(L(
      'Menjawab semua pertanyaan — menunjukkan persiapan yang matang.',
      'Answered every question — shows strong preparation.'));
    if (evals.some(e => /\b\d+/.test(e.ans || ''))) strengths.push(L(
      'Menyertakan data/angka untuk memperkuat argumen.',
      'Used data / numbers to back up arguments.'));
    if (evals.some(e => /(kembali ke indonesia|kontribusi|contribution|return to indonesia)/i.test(e.ans || ''))) strengths.push(L(
      'Visi kontribusi untuk Indonesia tersampaikan jelas.',
      'Vision for contributing to Indonesia comes across clearly.'));
    if (strengths.length === 0) strengths.push(L(
      'Upaya menjawab sudah ada — fokus untuk memperkuat substansi.',
      'You made an effort — now focus on strengthening the substance.'));

    if (answered.length < evals.length) weaknesses.push(
      (evals.length - answered.length) + (isEn ? ' question(s) were unanswered or too brief.' : ' pertanyaan tidak terjawab atau terlalu pendek.')
    );
    if (focusScores.Impact && focusScores.Impact < 65) weaknesses.push(L(
      'Aspek dampak/kontribusi perlu dipertajam dengan contoh konkret.',
      'The impact / contribution dimension needs sharper concrete examples.'));
    if (focusScores.Confidence && focusScores.Confidence < 65) weaknesses.push(L(
      'Tingkat keyakinan dalam jawaban perlu ditingkatkan.',
      'Confidence level in your answers needs to be raised.'));
    if (focusScores.Alignment && focusScores.Alignment < 65) weaknesses.push(L(
      'Kesesuaian rencana dengan nilai LPDP belum sepenuhnya tergambar.',
      'Alignment between your plans and LPDP values is not fully visible yet.'));
    if (weaknesses.length === 0) weaknesses.push(L(
      'Tidak ada kelemahan besar — polish jawaban dengan detail tambahan.',
      'No major weaknesses — polish answers with extra detail.'));

    topIssues.forEach(i => suggestions.push(i));
    if (suggestions.length < 3) suggestions.push(L(
      'Latih pengucapan di depan cermin atau rekam diri sendiri untuk mengevaluasi intonasi.',
      'Practice out loud in front of a mirror or record yourself to evaluate tone and pacing.'));
    if (suggestions.length < 4) suggestions.push(L(
      'Siapkan 2–3 cerita STAR (Situation, Task, Action, Result) untuk dipakai di beberapa pertanyaan.',
      'Prepare 2–3 STAR stories (Situation, Task, Action, Result) you can reuse across questions.'));

    // Render
    el('interviewStage').classList.add('hidden');
    el('resultStage').classList.remove('hidden');

    const readinessTitle = overall >= 80
      ? L('Sangat Siap', 'Very Ready')
      : overall >= 65 ? L('Cukup Siap', 'Fairly Ready')
      : overall >= 50 ? L('Perlu Latihan Lagi', 'Needs More Practice')
      : L('Butuh Persiapan Lebih Matang', 'Needs Much More Preparation');
    const readinessSub = overall >= 80
      ? L('Siap melangkah ke wawancara sesungguhnya.', 'Ready to move on to the real interview.')
      : overall >= 65
        ? L('Dasar sudah baik — pertajam substansi dan percaya diri.', 'Foundation is good — sharpen substance and confidence.')
        : L('Latih beberapa kali lagi untuk memperkuat jawabanmu.', 'Practice a few more times to strengthen your answers.');
    const answeredLine = L(
      `${answered.length} dari ${evals.length} pertanyaan terjawab • ${el('iTimer').textContent} total`,
      `${answered.length} of ${evals.length} questions answered • ${el('iTimer').textContent} total`
    );

    const hero = el('iResultHero');
    hero.style.setProperty('--pct', overall + '%');
    hero.innerHTML = `
      <div class="big-score">
        <div class="big-score-value">${overall}<small>/ 100</small></div>
      </div>
      <div>
        <h3>${readinessTitle}</h3>
        <p class="muted" style="margin:0">${answeredLine}</p>
        <p style="margin-top:8px;">${readinessSub}</p>
      </div>
    `;

    el('iMetrics').innerHTML = Object.entries(focusScores).map(([k, v]) =>
      `<div class="metric">
        <div class="metric-label"><span>${focusLabel(k)}</span><strong>${v}/100</strong></div>
        <div class="metric-bar"><span style="width:${v}%"></span></div>
      </div>`
    ).join('');

    el('iStrengths').innerHTML = strengths.map(s => `<li>${escapeHtml(s)}</li>`).join('');
    el('iWeaknesses').innerHTML = weaknesses.map(s => `<li>${escapeHtml(s)}</li>`).join('');
    el('iSuggestions').innerHTML = suggestions.map(s => `<li>${escapeHtml(s)}</li>`).join('');

    // Persist to DB if logged in
    App.saveInterviewSessionToDb({
      essayExcerpt: state.essay.slice(0, 500),
      questions: state.questions,
      answers: state.answers,
      overall,
      evaluation: { focusScores, strengths, weaknesses, suggestions, language: state.shortLang },
    });

    const reviewLabels = {
      question: L('Pertanyaan', 'Question'),
      score: L('Skor', 'Score'),
      answer: L('Jawaban', 'Answer'),
      notAnswered: L('(tidak dijawab)', '(not answered)'),
      audio: L('Rekaman suara', 'Audio recording'),
      notes: L('Catatan', 'Notes'),
    };

    el('iReviewList').innerHTML = evals.map((e, i) => {
      const audioUrl = state.audioBlobs[i];
      return `
      <div class="paragraph-card">
        <h5>${reviewLabels.question} ${i+1} <small class="muted">• ${focusLabel(e.q.focus)} • ${reviewLabels.score} ${e.eval.score}/100</small></h5>
        <div class="quote">${escapeHtml(e.q.q)}</div>
        <div class="note"><strong>${reviewLabels.answer}:</strong> ${e.ans ? escapeHtml(e.ans) : `<em>${reviewLabels.notAnswered}</em>`}</div>
        ${audioUrl ? `<div style="margin-top:10px;"><small class="muted">${reviewLabels.audio}:</small><br><audio controls src="${audioUrl}" style="width:100%; margin-top:4px;"></audio></div>` : ''}
        ${e.eval.notes.length ? `<div class="explanation" style="margin-top:10px;"><strong>${reviewLabels.notes}:</strong> ${e.eval.notes.map(escapeHtml).join(' • ')}</div>` : ''}
      </div>
      `;
    }).join('');
  }

  function focusLabel(k) {
    const isEn = state.shortLang === 'en';
    const map = isEn ? {
      Clarity: 'Clarity',
      Motivation: 'Motivation',
      Confidence: 'Confidence',
      Alignment: 'Goal Alignment',
      Impact: 'Impact',
      Relevance: 'LPDP Relevance',
    } : {
      Clarity: 'Kejelasan',
      Motivation: 'Motivasi',
      Confidence: 'Kepercayaan Diri',
      Alignment: 'Kesesuaian Tujuan',
      Impact: 'Dampak',
      Relevance: 'Relevansi LPDP',
    };
    return map[k] || k;
  }
  // Backwards-compat alias (in case referenced elsewhere)
  const focusLabelID = focusLabel;

  el('iRetry').addEventListener('click', () => {
    // Clean up any existing audio blob URLs
    state.audioBlobs.forEach(u => { if (u) URL.revokeObjectURL(u); });
    state.audioBlobs = [];
    state.paused = false;
    state.finished = false;
    stopQuestionTimer();
    stopMediaStream();
    el('cameraPip').classList.add('hidden');
    el('interviewStage').classList.remove('paused');
    el('iPauseBtn').textContent = state.shortLang === 'en' ? '⏸ Pause' : '⏸ Jeda';
    el('resultStage').classList.add('hidden');
    el('essayStage').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Release camera/mic if user navigates away
  window.addEventListener('beforeunload', () => {
    stopMediaStream();
    state.audioBlobs.forEach(u => { if (u) URL.revokeObjectURL(u); });
  });
  el('iDetails').addEventListener('click', () => {
    const p = el('iDetailsPanel');
    p.classList.toggle('hidden');
    el('iDetails').textContent = p.classList.contains('hidden') ? 'Lihat Semua Jawaban' : 'Sembunyikan Review';
  });

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
})();
