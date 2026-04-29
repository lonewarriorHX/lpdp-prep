// Essay Checker — heuristic analysis with 3-aspect coverage

(function () {
  const el = (id) => document.getElementById(id);
  const textarea = el('essayText');
  const wordCount = el('wordCount');
  const paraCount = el('paraCount');
  const uniSelect = el('universitySelect');
  const locSelect = el('universityLocation');
  const degreeSelect = el('degreeLevel');
  const langSelect = el('essayLanguage');

  let universities = [];

  const SAMPLE = `Saya Andi Prasetyo, lulusan Teknik Lingkungan Universitas Indonesia. Tumbuh di desa kecil di Jawa Tengah yang mengalami krisis air bersih membuat saya memahami betapa pentingnya pengelolaan sumber daya air yang berkelanjutan. Motivasi saya melanjutkan studi S2 berakar dari pengalaman ini — saya bertekad menjadi ahli yang mampu memberikan solusi nyata bagi masalah air di Indonesia.

Selama kuliah, saya aktif dalam organisasi lingkungan dan memimpin proyek pembangunan instalasi penjernihan air sederhana di tiga desa. Proyek ini berdampak pada lebih dari 450 keluarga. Pengalaman tersebut menguatkan komitmen saya bahwa ilmu teknik harus diiringi empati dan pemahaman sosial.

Melalui beasiswa LPDP, saya berencana melanjutkan Master of Science in Water Resources Management di Delft University of Technology. Program ini dipilih karena unggul dalam riset pengelolaan air berbasis teknologi dan kebijakan. Saya akan mengambil mata kuliah Integrated Water Resources Management dan melakukan tesis mengenai pengelolaan air terpadu untuk wilayah pedesaan tropis.

Setelah lulus, saya berkomitmen kembali ke Indonesia untuk berkontribusi di Kementerian PUPR atau lembaga riset seperti BRIN. Dalam lima tahun pertama pasca studi, saya menargetkan merancang sistem pengelolaan air untuk 50 desa tertinggal. Lebih jauh, saya ingin mendirikan pusat pelatihan pengelolaan air komunitas yang dapat direplikasi di seluruh Indonesia, memberikan dampak bagi bangsa.

Saya percaya setiap orang berhak atas air bersih. Dengan ilmu, pengalaman, dan komitmen yang saya miliki, saya yakin mampu menjadi bagian dari solusi bagi masyarakat Indonesia.`;

  function updateCount() {
    const t = textarea.value.trim();
    const words = t ? t.split(/\s+/).length : 0;
    const paras = t ? t.split(/\n\s*\n/).filter(p => p.trim().length).length : 0;
    wordCount.textContent = words;
    paraCount.textContent = paras;
  }
  textarea.addEventListener('input', updateCount);

  el('sampleBtn').addEventListener('click', () => { textarea.value = SAMPLE; updateCount(); });
  el('clearBtn').addEventListener('click', () => {
    textarea.value = ''; updateCount();
    el('emptyState').classList.remove('hidden');
    el('resultContent').classList.add('hidden');
  });

  // -------- University loader --------
  async function loadUniversities() {
    uniSelect.innerHTML = '<option value="">Memuat...</option>';
    const location = locSelect.value;
    universities = await App.fetchUniversities(location);
    if (!universities.length) {
      uniSelect.innerHTML = '<option value="">— Tidak ada data. Jalankan supabase/universities.sql —</option>';
      return;
    }
    uniSelect.innerHTML = '<option value="">-- Pilih universitas --</option>' +
      universities.map(u => {
        const label = u.short_name ? `${u.name} (${u.short_name})` : u.name;
        const country = u.country && location === 'luar_negeri' ? ` — ${u.country}` : '';
        return `<option value="${u.id || ''}" data-name="${escapeAttr(u.name)}">${escapeHtml(label)}${country}</option>`;
      }).join('');
  }
  locSelect.addEventListener('change', loadUniversities);
  loadUniversities();

  // -------- Keyword banks (Indonesian + English) --------
  const BANKS = {
    id: {
      IMPACT_WORDS: ['membangun','menciptakan','mengembangkan','memberdayakan','meningkatkan','mengurangi','menyelesaikan','menghasilkan','merancang','mendirikan','mentransformasi','memimpin'],
      STRUCTURE_MARKERS: ['pertama','kedua','ketiga','selanjutnya','selain itu','oleh karena itu','sebagai','melalui','setelah','akhirnya','dengan demikian'],
      VAGUE_WORDS: ['mungkin','sepertinya','kira-kira','agak','biasa saja','sedikit banyak','kurang lebih'],
      ASPECTS: {
        kontribusi: {
          label: 'Kontribusi bagi Indonesia',
          keywords: ['indonesia','bangsa','negara','masyarakat','kontribusi','berkontribusi','pengabdian','dampak','bermanfaat','rakyat','pedesaan','daerah','pembangunan','sosial','komunitas'],
          critical: ['indonesia','kontribusi','masyarakat','bangsa'],
          hint: 'Sebutkan rencana kontribusi nyata untuk Indonesia — target lembaga, wilayah, jumlah orang yang terdampak.'
        },
        rencana: {
          label: 'Rencana Studi & Pasca Studi',
          keywords: ['rencana','studi','program','jurusan','prodi','mata kuliah','kurikulum','tesis','disertasi','riset','setelah lulus','pasca','jangka panjang','karir','target','lembaga','kementerian','pekerjaan','bekerja','5 tahun','10 tahun'],
          critical: ['rencana','setelah lulus','studi'],
          hint: 'Jabarkan rencana studi (mata kuliah/topik riset) dan rencana pasca studi (lembaga, target waktu, peran).'
        },
        motivasi: {
          label: 'Motivasi & Komitmen',
          keywords: ['motivasi','alasan','bercita-cita','bertekad','bermimpi','tujuan','mengapa','latar belakang','pengalaman','komitmen','berkomitmen','saya percaya','saya yakin','saya siap','terpanggil','terdorong','passion'],
          critical: ['motivasi','komitmen','saya yakin','saya percaya','bertekad'],
          hint: 'Ceritakan pengalaman pribadi atau titik balik yang menjadi motivasi, serta komitmenmu yang kuat.'
        }
      }
    },
    en: {
      IMPACT_WORDS: ['build','create','develop','empower','improve','reduce','solve','produce','design','establish','transform','lead','launch','implement','deliver','drive','advance'],
      STRUCTURE_MARKERS: ['first','second','third','next','furthermore','moreover','therefore','through','after','finally','thus','in addition','consequently'],
      VAGUE_WORDS: ['maybe','perhaps','somewhat','rather','quite','a little','more or less','kind of','sort of'],
      ASPECTS: {
        kontribusi: {
          label: 'Contribution to Indonesia',
          keywords: ['indonesia','indonesian','nation','country','society','contribute','contribution','impact','give back','return','people','community','rural','underdeveloped','development','social','homeland'],
          critical: ['indonesia','contribute','contribution','society','nation'],
          hint: 'State a concrete contribution to Indonesia — target institution, region, and number of people impacted.'
        },
        rencana: {
          label: 'Study Plan & Post-Study Plan',
          keywords: ['plan','study','program','course','courses','curriculum','thesis','dissertation','research','after graduation','post-study','long-term','career','target','institution','ministry','work','years','role','position'],
          critical: ['plan','after graduation','study','research'],
          hint: 'Outline your study plan (courses/research topic) and post-study plan (institution, timeline, role).'
        },
        motivasi: {
          label: 'Motivation & Commitment',
          keywords: ['motivation','reason','dream','aspire','goal','why','background','experience','commitment','committed','i believe','i am confident','determined','driven','passion','passionate','inspired','turning point'],
          critical: ['motivation','commitment','i believe','i am confident','determined'],
          hint: 'Share a personal experience or turning point that drives your motivation, and your strong commitment.'
        }
      }
    }
  };
  let currentBank = BANKS.id;

  // -------- Similarity engine (TF-IDF + cosine) --------
  const STOPWORDS = {
    id: new Set(['yang','di','dan','ini','itu','dari','ke','pada','untuk','saya','dengan','adalah','akan','juga','atau','tidak','dalam','sebagai','oleh','bahwa','agar','sudah','telah','bisa','dapat','harus','hanya','lebih','sangat','karena','namun','tetapi','jika','maka','oleh','para','sang','nya','mu','ku','aku','kita','kami','mereka','dia','nya','suatu','seperti','secara','tersebut','masing','setiap','masih','lagi','pun','bagi','saat','ketika','sehingga','sebelum','sesudah','selama','setelah','atas','bawah','antar','antara','kepada','yaitu','yakni','ialah','adapun','pula','demikian','begitu','hal','hal-hal','seorang','sebuah','satu','dua','tiga','nol','ya','ah','oh','oke','ok']),
    en: new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','of','in','on','at','to','for','with','as','by','from','this','that','these','those','it','its','and','or','but','if','then','so','than','because','while','when','which','who','whom','what','where','why','how','i','me','my','mine','we','us','our','you','your','they','them','their','he','him','his','she','her','hers','also','very','just','much','more','most','less','only','not','no','yes','up','down','out','into','over','under','between','through','during','before','after','about','again','further','here','there','such','can','could','should','would','may','might','must','will','shall','am','own'])
  };

  function tokenize(text, language) {
    const stop = STOPWORDS[language] || STOPWORDS.id;
    return text.toLowerCase()
      .replace(/[^\p{L}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !stop.has(t));
  }

  function termFreq(tokens) {
    const tf = {};
    tokens.forEach(t => tf[t] = (tf[t] || 0) + 1);
    const total = tokens.length || 1;
    Object.keys(tf).forEach(k => tf[k] /= total);
    return tf;
  }

  function buildIdf(corpusTokens) {
    const df = {};
    const N = corpusTokens.length;
    corpusTokens.forEach(tokens => {
      const unique = new Set(tokens);
      unique.forEach(t => df[t] = (df[t] || 0) + 1);
    });
    const idf = {};
    Object.keys(df).forEach(k => idf[k] = Math.log((N + 1) / (df[k] + 1)) + 1);
    return idf;
  }

  function tfIdfVector(tf, idf) {
    const v = {};
    Object.keys(tf).forEach(k => {
      if (idf[k]) v[k] = tf[k] * idf[k];
    });
    return v;
  }

  function cosineSim(a, b) {
    let dot = 0, magA = 0, magB = 0;
    Object.keys(a).forEach(k => { magA += a[k] * a[k]; if (b[k]) dot += a[k] * b[k]; });
    Object.keys(b).forEach(k => { magB += b[k] * b[k]; });
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom ? dot / denom : 0;
  }

  async function computeSimilarity(userText, ctx) {
    const refs = await App.fetchReferenceEssays(ctx.language);
    if (!refs.length) return { available: false, count: 0 };
    const refTokens = refs.map(r => tokenize(r.content, ctx.language));
    const userTokens = tokenize(userText, ctx.language);
    const idf = buildIdf(refTokens.concat([userTokens]));
    const userVec = tfIdfVector(termFreq(userTokens), idf);
    const matches = refs.map((r, i) => {
      const refVec = tfIdfVector(termFreq(refTokens[i]), idf);
      return { ref: r, score: cosineSim(userVec, refVec) };
    }).sort((a, b) => b.score - a.score);
    const top = matches.slice(0, 3);
    const maxScore = matches[0]?.score || 0;
    const avgTop3 = top.reduce((s, m) => s + m.score, 0) / (top.length || 1);
    // Blend max (dominant signal) + avg top-3 (stability)
    const blended = maxScore * 0.65 + avgTop3 * 0.35;
    return {
      available: true,
      count: refs.length,
      score: Math.round(blended * 100),
      maxScore: Math.round(maxScore * 100),
      avgTop3: Math.round(avgTop3 * 100),
      topMatches: top.map(m => ({
        id: m.ref.id,
        title: m.ref.title,
        university: m.ref.university_name,
        author: m.ref.author,
        percent: Math.round(m.score * 100),
      })),
    };
  }

  function countMatches(text, list) {
    const lower = text.toLowerCase();
    let count = 0;
    const found = [];
    list.forEach(w => {
      const re = new RegExp('\\b' + w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b', 'g');
      const matches = lower.match(re);
      if (matches) { count += matches.length; found.push(w); }
    });
    return { count, found };
  }

  function checkAspect(text, key) {
    const cfg = currentBank.ASPECTS[key];
    const total = countMatches(text, cfg.keywords);
    const critical = countMatches(text, cfg.critical);
    // Scoring: critical keywords matter most
    let score = 20;
    score += Math.min(critical.count * 15, 45);
    score += Math.min(total.count * 3, 35);
    score = Math.max(0, Math.min(100, score));
    const present = critical.count >= 1 && total.count >= 3;
    return {
      label: cfg.label,
      score,
      present,
      found: total.found,
      hint: cfg.hint,
    };
  }

  // -------- Main analysis --------
  function analyze(text, ctx) {
    currentBank = BANKS[ctx.language] || BANKS.id;
    const clean = text.trim();
    const words = clean.split(/\s+/).filter(Boolean);
    const wordN = words.length;
    const sentences = clean.split(/[.!?]+/).filter(s => s.trim().length > 3);
    const paragraphs = clean.split(/\n\s*\n/).filter(p => p.trim().length);
    const avgSentenceLen = sentences.length ? wordN / sentences.length : 0;

    // Structure
    let structure = 50;
    if (paragraphs.length >= 4) structure += 20; else if (paragraphs.length >= 3) structure += 10;
    const markers = countMatches(clean, currentBank.STRUCTURE_MARKERS).count;
    structure += Math.min(markers * 3, 20);
    if (wordN < 300) structure -= 15;
    structure = Math.max(0, Math.min(100, structure));

    // Clarity
    let clarity = 75;
    if (avgSentenceLen > 28) clarity -= 15;
    else if (avgSentenceLen > 22) clarity -= 5;
    else if (avgSentenceLen < 8 && sentences.length > 3) clarity -= 10;
    const vague = countMatches(clean, currentBank.VAGUE_WORDS).count;
    clarity -= Math.min(vague * 4, 20);
    clarity += Math.min(Math.floor(wordN / 100), 10);
    clarity = Math.max(0, Math.min(100, clarity));

    // Impact
    let impact = 40;
    const impactVerbs = countMatches(clean, currentBank.IMPACT_WORDS).count;
    impact += Math.min(impactVerbs * 6, 35);
    const numbers = (clean.match(/\b\d+[\d.,]*\b/g) || []).length;
    impact += Math.min(numbers * 4, 20);
    impact = Math.max(0, Math.min(100, impact));

    // Coverage (3 required aspects)
    const coverage = {
      kontribusi: checkAspect(clean, 'kontribusi'),
      rencana: checkAspect(clean, 'rencana'),
      motivasi: checkAspect(clean, 'motivasi'),
    };
    const coverageAvg = Math.round((coverage.kontribusi.score + coverage.rencana.score + coverage.motivasi.score) / 3);
    const coveredCount = Object.values(coverage).filter(c => c.present).length;

    // University & degree consistency check
    const uniCheck = { matched: null, warning: null };
    if (ctx.universityName) {
      const patterns = [ctx.universityName];
      if (ctx.universityShort && ctx.universityShort !== ctx.universityName) patterns.push(ctx.universityShort);
      const uniRe = new RegExp(patterns.map(p => p.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|'), 'i');
      uniCheck.matched = uniRe.test(clean);
      if (!uniCheck.matched) {
        uniCheck.warning = `Essay tidak menyebutkan "${ctx.universityName}". Sebutkan universitas tujuan secara eksplisit agar konsisten dengan pilihanmu.`;
      }
    }
    const degreeCheck = { matched: false, warning: null };
    const degreeRe = {
      s1: /\b(s1|sarjana|bachelor|undergraduate)\b/i,
      s2: /\b(s2|master|magister|ms|msc|m\.sc|m\.a|mba)\b/i,
      s3: /\b(s3|doktor|ph\.?d|doctoral)\b/i,
    }[ctx.degreeLevel] || null;
    if (degreeRe) {
      degreeCheck.matched = degreeRe.test(clean);
      if (!degreeCheck.matched) {
        degreeCheck.warning = `Jenjang studi ${ctx.degreeLevel.toUpperCase()} tidak disebut. Tambahkan agar rencana studi jelas.`;
      }
    }

    // Overall score
    const overall = Math.round(structure * 0.2 + clarity * 0.2 + impact * 0.2 + coverageAvg * 0.4);

    // Strengths / Weaknesses / Suggestions
    const strengths = [];
    const weaknesses = [];
    const suggestions = [];

    if (coveredCount === 3) strengths.push('Ketiga aspek wajib (kontribusi, rencana studi, motivasi) tercakup.');
    else weaknesses.push(`Hanya ${coveredCount} dari 3 aspek wajib yang tercakup dengan baik.`);

    Object.entries(coverage).forEach(([k, v]) => {
      if (!v.present) suggestions.push(v.hint);
    });

    if (wordN >= 400) strengths.push('Panjang essay memadai untuk mengeksplorasi semua aspek.');
    else if (wordN < 300) weaknesses.push('Essay di bawah 300 kata — sulit mencakup semua aspek dengan memadai.');

    if (paragraphs.length >= 4) strengths.push('Struktur paragraf cukup jelas.');
    else suggestions.push('Pisahkan menjadi minimal 4 paragraf untuk tiap aspek: motivasi, pengalaman, rencana studi, kontribusi.');

    if (impactVerbs >= 5) strengths.push('Banyak kata kerja aksi — menunjukkan inisiatif konkret.');
    if (numbers >= 2) strengths.push('Menyertakan angka/data konkret.');
    else weaknesses.push('Minim angka/data. Kuantifikasi pencapaian atau target.');

    if (vague >= 2) weaknesses.push(`Terdapat ${vague} frasa ragu ("mungkin"/"agak"). Gunakan bahasa tegas.`);
    if (avgSentenceLen > 25) suggestions.push(`Kalimat rata-rata ${Math.round(avgSentenceLen)} kata — pecah agar mudah dibaca.`);

    if (uniCheck.warning) weaknesses.push(uniCheck.warning);
    else if (uniCheck.matched) strengths.push(`Universitas tujuan (${ctx.universityName}) disebut konsisten.`);
    if (degreeCheck.warning) suggestions.push(degreeCheck.warning);

    if (!/lpdp/i.test(clean)) suggestions.push('Sebutkan LPDP secara eksplisit untuk menunjukkan kesesuaian dengan misi beasiswa.');

    // Per-paragraph analysis — map paragraphs to aspects based on keywords
    const paraAnalysis = paragraphs.map((p, i) => {
      const pWords = p.trim().split(/\s+/).length;
      const pSents = p.split(/[.!?]+/).filter(s => s.trim()).length;
      const scores = {
        kontribusi: countMatches(p, currentBank.ASPECTS.kontribusi.keywords).count,
        rencana: countMatches(p, currentBank.ASPECTS.rencana.keywords).count,
        motivasi: countMatches(p, currentBank.ASPECTS.motivasi.keywords).count,
      };
      const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
      const dominant = best[1] >= 2 ? currentBank.ASPECTS[best[0]].label : (ctx.language === 'en' ? 'General / Transition' : 'Umum / Transisi');
      let note = '';
      if (pWords < 30) note = 'Paragraf terlalu pendek — perluas dengan detail konkret.';
      else if (pWords > 200) note = 'Paragraf sangat panjang — pertimbangkan memecahnya.';
      else note = 'Panjang paragraf proporsional.';
      if (pSents === 1) note += ' Hanya satu kalimat — perkaya dengan elaborasi.';
      const preview = p.length > 140 ? p.slice(0, 140).trim() + '…' : p.trim();
      return { heading: `Paragraf ${i + 1} — ${dominant}`, preview, words: pWords, note };
    });

    return {
      overall, structure, clarity, impact, coverageAvg, coveredCount,
      wordN, sentences: sentences.length, paragraphs: paragraphs.length,
      coverage, strengths, weaknesses, suggestions, paraAnalysis,
      context: ctx,
    };
  }

  // -------- Render --------
  function render(result) {
    const r = result;
    const isPro = App.getIsPro ? App.getIsPro() : false;
    const lockedClass = isPro ? '' : 'pro-locked';
    const upgradeOverlay = isPro ? '' : `
      <div class="pro-overlay">
        <div class="pro-overlay-card">
          <div class="pro-overlay-icon">🔒</div>
          <h3 style="margin:0 0 8px">Analisis Mendalam Khusus Pro</h3>
          <p class="muted" style="margin:0 0 16px; max-width:420px;">
            Untuk membuka metrik detail (struktur, kejelasan, dampak), daftar essay referensi
            paling mirip, kekuatan & kelemahan, saran perbaikan konkret, analisis per paragraf,
            dan feedback komparatif AI vs awardee — upgrade ke Pro.
          </p>
          <button class="btn btn-primary" id="upgradeProBtn">🔓 Upgrade ke Pro</button>
        </div>
      </div>
    `;
    const html = `
      <div class="score-hero" style="--pct:${r.overall}%">
        <div class="big-score">
          <div class="big-score-value">${r.overall}<small>/ 100</small></div>
        </div>
        <div>
          <h3>${scoreLabel(r.overall)}</h3>
          <p class="muted" style="margin:0">${r.wordN} kata • ${r.sentences} kalimat • ${r.paragraphs} paragraf</p>
          <p style="margin-top:8px;">${scoreVerdict(r.overall)}</p>
          ${r.context.universityName ? `<p class="muted" style="margin-top:4px; font-size:0.9rem;">Target: ${escapeHtml(r.context.degreeLevel.toUpperCase())} di ${escapeHtml(r.context.universityName)}</p>` : ''}
        </div>
      </div>

      <div class="analysis-block">
        <h4>Cakupan Tiga Aspek Wajib <small class="muted" style="font-weight:400">(${r.coveredCount}/3 tercakup)</small></h4>
        <div class="coverage-grid">
          ${renderCoverage('kontribusi', r.coverage.kontribusi)}
          ${renderCoverage('rencana', r.coverage.rencana)}
          ${renderCoverage('motivasi', r.coverage.motivasi)}
        </div>
      </div>

      ${renderSimilarityCard(r.similarity)}

      <div class="pro-content-wrap ${lockedClass}">
        ${upgradeOverlay}
        <div class="pro-content">

      <div class="metrics">
        ${metric('Struktur', r.structure)}
        ${metric('Kejelasan', r.clarity)}
        ${metric('Dampak', r.impact)}
        ${metric('Cakupan Aspek', r.coverageAvg)}
      </div>

      ${renderSimilarityMatches(r.similarity)}

      ${renderAwardeeFeedback(r.awardeeFeedback, r.awardeeFeedbackError, r.awardeeFeedbackLoading, r.awardeeFeedbackIsPro)}

      <div class="analysis-block">
        <h4><span class="tag tag-strong">Kekuatan</span></h4>
        ${listOrEmpty(r.strengths, 'Belum ada kekuatan menonjol terdeteksi.')}
      </div>
      <div class="analysis-block">
        <h4><span class="tag tag-weak">Kelemahan</span></h4>
        ${listOrEmpty(r.weaknesses, 'Tidak ada kelemahan utama terdeteksi.')}
      </div>
      <div class="analysis-block">
        <h4><span class="tag tag-tip">Saran Perbaikan</span></h4>
        ${listOrEmpty(r.suggestions, 'Essay sudah solid. Polish lagi gaya bahasa dan ejaan.')}
      </div>

      <div class="analysis-block">
        <h4>Analisis per Paragraf</h4>
        ${r.paraAnalysis.map(p => `
          <div class="paragraph-card">
            <h5>${escapeHtml(p.heading)} <small class="muted" style="font-weight:400">— ${p.words} kata</small></h5>
            <div class="quote">${escapeHtml(p.preview)}</div>
            <div class="note">${escapeHtml(p.note)}</div>
          </div>
        `).join('')}
      </div>

      <div style="margin-top:20px; display:flex; gap:12px; flex-wrap:wrap;">
        <a href="interview.html" class="btn btn-primary">Lanjut ke Simulasi Wawancara →</a>
        <button class="btn btn-ghost" id="saveEssayBtn">Simpan Essay untuk Interview</button>
      </div>

        </div>
      </div>
    `;
    el('emptyState').classList.add('hidden');
    const rc = el('resultContent');
    rc.innerHTML = html;
    rc.classList.remove('hidden');
    const saveBtn = el('saveEssayBtn');
    if (saveBtn) saveBtn.onclick = () => {
      App.saveEssay(textarea.value);
      saveBtn.textContent = '✓ Essay Tersimpan';
      saveBtn.disabled = true;
    };
    const upgradeBtn = el('upgradeProBtn');
    if (upgradeBtn) upgradeBtn.onclick = () => {
      window.location.href = 'pricing.html';
    };
  }

  function renderSimilarityCard(sim) {
    if (!sim) return '';
    if (!sim.available) {
      return `
        <div class="analysis-block">
          <h4>Kemiripan dengan Essay Lolos LPDP</h4>
          <div class="sim-empty">
            <p class="muted" style="margin:0">Belum ada essay referensi${sim.error ? ' (gagal memuat data)' : ''}. Tambahkan essay-essay yang pernah lolos di halaman <a href="admin.html">Training Data</a> agar sistem bisa menghitung kemiripan.</p>
          </div>
        </div>
      `;
    }
    const s = sim.score;
    const band = s >= 55 ? { cls: 'sim-very-high', label: 'Sangat Tinggi', note: 'Sangat mirip dengan essay lolos — tapi pastikan tetap orisinil, jangan terlalu meniru frasa.' }
              : s >= 35 ? { cls: 'sim-high', label: 'Tinggi', note: 'Gaya dan tema essay sangat selaras dengan pola essay yang lolos.' }
              : s >= 20 ? { cls: 'sim-mid', label: 'Sedang', note: 'Ada overlap tema. Perkuat kosakata dan kerangka khas essay LPDP.' }
              : { cls: 'sim-low', label: 'Rendah', note: 'Masih jauh dari pola essay yang lolos. Pelajari struktur dan kosakata yang sering muncul.' };
    return `
      <div class="analysis-block">
        <h4>Kemiripan dengan Essay Lolos LPDP <small class="muted" style="font-weight:400">(${sim.count} referensi)</small></h4>
        <div class="sim-card ${band.cls}">
          <div class="sim-score">
            <strong>${s}%</strong>
            <span>${band.label}</span>
          </div>
          <div class="sim-body">
            <div class="sim-bar"><span style="width:${s}%"></span></div>
            <p class="sim-note">${band.note}</p>
            <div class="sim-meta">
              <span>Tertinggi: <strong>${sim.maxScore}%</strong></span>
              <span>Rata-rata top 3: <strong>${sim.avgTop3}%</strong></span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderSimilarityMatches(sim) {
    if (!sim || !sim.available || !sim.topMatches?.length) return '';
    return `
      <div class="analysis-block">
        <h4>Essay Referensi Paling Mirip</h4>
        ${sim.topMatches.map(m => `
          <div class="sim-match">
            <div>
              <div style="font-weight:600;">${escapeHtml(m.title || 'Untitled')}</div>
              <small class="muted">${m.university ? escapeHtml(m.university) : ''}${m.author ? ' • ' + escapeHtml(m.author) : ''}</small>
            </div>
            <span class="tag ${m.percent >= 40 ? 'tag-strong' : m.percent >= 20 ? 'tag-tip' : 'tag-weak'}" style="font-size:0.8rem;">${m.percent}%</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderAwardeeFeedback(fb, err, loading, isPro) {
    if (loading) {
      return `
        <div class="analysis-block">
          <h4>Feedback Komparatif vs Awardee LPDP</h4>
          <div class="fb-loading">
            <div class="fb-spinner"></div>
            <p class="muted" style="margin:0">Membandingkan essay Anda dengan pola awardee...</p>
          </div>
        </div>
      `;
    }
    if (err) {
      return `
        <div class="analysis-block">
          <h4>Feedback Komparatif vs Awardee LPDP</h4>
          <div class="sim-empty">
            <p class="muted" style="margin:0">Gagal memuat feedback komparatif: ${escapeHtml(err)}</p>
            <p class="muted" style="margin:6px 0 0 0; font-size:0.8rem;">Pastikan Edge Function <code>essay-feedback</code> sudah di-deploy dan <code>GEMINI_API_KEY</code> sudah di-set.</p>
          </div>
        </div>
      `;
    }
    if (!fb) return '';
    const aspects = [
      { key: 'motivasi', label: 'Motivasi' },
      { key: 'kontribusi', label: 'Kontribusi untuk Indonesia' },
      { key: 'rencana_studi', label: 'Rencana Studi' },
    ];
    const cardFor = (a) => {
      const f = fb[a.key];
      if (!f) return '';
      const cls = f.strength === 'stronger' ? 'fb-stronger'
                : f.strength === 'weaker' ? 'fb-weaker'
                : 'fb-comparable';
      const icon = f.strength === 'stronger' ? '↑'
                 : f.strength === 'weaker' ? '↓'
                 : '≈';
      return `
        <div class="fb-card ${cls}">
          <div class="fb-head">
            <h5><span class="fb-icon">${icon}</span> ${a.label}</h5>
            <span class="fb-badge">${escapeHtml(f.qualitative_label || f.strength || '')}</span>
          </div>
          <p class="fb-reason">${escapeHtml(f.reasoning || '')}</p>
          ${f.improvement ? `<div class="fb-tip"><strong>💡 Saran:</strong> ${escapeHtml(f.improvement)}</div>` : ''}
        </div>
      `;
    };
    return `
      <div class="analysis-block">
        <h4>Feedback Komparatif vs Awardee LPDP</h4>
        ${fb.overall_summary ? `<p class="fb-summary">${escapeHtml(fb.overall_summary)}</p>` : ''}
        <div class="fb-grid">
          ${aspects.map(cardFor).join('')}
        </div>
        <p class="muted" style="font-size:0.78rem; margin-top:10px;">⚠ Feedback dihasilkan AI berdasarkan pola essay awardee yang Anda upload. Gunakan sebagai panduan, bukan kebenaran absolut.</p>
      </div>
    `;
  }

  function renderCoverage(key, c) {
    const statusClass = c.present ? 'covered' : 'missing';
    const icon = c.present ? '✓' : '✗';
    const label = c.present ? 'Tercakup' : 'Belum Tercakup';
    return `
      <div class="coverage-item coverage-${statusClass}">
        <div class="coverage-icon">${icon}</div>
        <div class="coverage-body">
          <div class="coverage-title">${escapeHtml(c.label)}</div>
          <div class="coverage-meta">${label} • ${c.score}/100</div>
          <div class="coverage-bar"><span style="width:${c.score}%"></span></div>
          ${!c.present ? `<div class="coverage-hint">${escapeHtml(c.hint)}</div>` : ''}
        </div>
      </div>
    `;
  }

  function metric(label, val) {
    return `<div class="metric">
      <div class="metric-label"><span>${label}</span><strong>${val}/100</strong></div>
      <div class="metric-bar"><span style="width:${val}%"></span></div>
    </div>`;
  }
  function listOrEmpty(items, empty) {
    if (!items.length) return `<p class="muted" style="margin:0">${empty}</p>`;
    return '<ul>' + items.map(i => `<li>${escapeHtml(i)}</li>`).join('') + '</ul>';
  }
  function scoreLabel(s) {
    if (s >= 85) return 'Sangat Baik';
    if (s >= 70) return 'Baik';
    if (s >= 55) return 'Cukup';
    if (s >= 40) return 'Perlu Perbaikan';
    return 'Butuh Revisi Signifikan';
  }
  function scoreVerdict(s) {
    if (s >= 85) return 'Essay kuat dan siap diajukan. Polish final saja.';
    if (s >= 70) return 'Essay solid, beberapa area bisa dipertajam.';
    if (s >= 55) return 'Dasar sudah ada, butuh pengembangan lebih lanjut.';
    return 'Revisi menyeluruh disarankan sebelum submit.';
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
  function escapeAttr(s) { return escapeHtml(s); }

  el('analyzeBtn').addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (text.split(/\s+/).filter(Boolean).length < 100) {
      alert('Essay terlalu pendek. Minimal 100 kata untuk mulai dianalisis (disarankan 300+).');
      return;
    }
    const selectedOpt = uniSelect.options[uniSelect.selectedIndex];
    const ctx = {
      language: langSelect.value,
      degreeLevel: degreeSelect.value,
      universityLocation: locSelect.value,
      universityId: uniSelect.value || null,
      universityName: selectedOpt && selectedOpt.dataset.name ? selectedOpt.dataset.name : null,
    };
    if (ctx.universityId) {
      const u = universities.find(x => x.id === ctx.universityId);
      if (u) ctx.universityShort = u.short_name;
    }
    const btn = el('analyzeBtn');
    btn.disabled = true; btn.textContent = 'Menganalisis...';
    const result = analyze(text, ctx);
    // Compute similarity asynchronously
    try {
      result.similarity = await computeSimilarity(text, ctx);
    } catch (err) {
      console.warn('Similarity error:', err);
      result.similarity = { available: false, count: 0, error: true };
    }
    // Render local results first (fast feedback) so the user isn't staring at a frozen button
    btn.disabled = false; btn.textContent = 'Analisis Essay';
    render(result);
    window.scrollTo({ top: el('resultPanel').offsetTop - 80, behavior: 'smooth' });
    App.saveEssayToDb(text, ctx, result);

    // Then fetch the LLM comparative feedback in the background and re-render
    if (result.similarity?.available && result.similarity.topMatches?.length) {
      result.awardeeFeedbackLoading = true;
      render(result);
      try {
        const fb = await App.getAwardeeFeedback({
          userEssay: text,
          language: ctx.language,
          topMatchIds: result.similarity.topMatches.map(m => m.id),
        });
        result.awardeeFeedbackLoading = false;
        if (fb.ok) {
          result.awardeeFeedback = fb.feedback;
          result.awardeeFeedbackIsPro = fb.isPro;
        } else {
          result.awardeeFeedbackError = fb.error;
        }
      } catch (err) {
        console.warn('Awardee feedback error:', err);
        result.awardeeFeedbackLoading = false;
        result.awardeeFeedbackError = String(err);
      }
      render(result);
    }
  });

  // Load saved draft
  const saved = App.getEssay();
  if (saved) { textarea.value = saved; updateCount(); }
})();
