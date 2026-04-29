// TBS Quiz controller

(function () {
  const FREE_QUESTION_LIMIT = 5;
  const el = (id) => document.getElementById(id);
  const state = {
    category: 'verbal',
    count: 10,
    duration: 10, // minutes
    questions: [],
    answers: [],
    idx: 0,
    timerId: null,
    remaining: 0,
  };

  function isPro() { return !!(window.App && App.getIsPro && App.getIsPro()); }

  // Category selection
  document.querySelectorAll('.category-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.category-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      state.category = card.dataset.cat;
    });
  });

  // Free-tier gating UI on the setup screen.
  function renderFreeTierNotice() {
    const setup = el('setupView');
    if (!setup) return;
    let notice = el('freeTierNotice');
    if (isPro()) {
      if (notice) notice.remove();
      // Re-enable any locked dropdown options.
      const qSel = el('qCount');
      if (qSel) Array.from(qSel.options).forEach(o => { o.disabled = false; o.textContent = o.textContent.replace(/\s*\(Pro\)$/, ''); });
      return;
    }
    // Non-pro: cap dropdown to 5 soal and add lock badge to others.
    const qSel = el('qCount');
    if (qSel) {
      Array.from(qSel.options).forEach(o => {
        const v = parseInt(o.value, 10);
        if (v > FREE_QUESTION_LIMIT) {
          o.disabled = true;
          if (!/\(Pro\)$/.test(o.textContent)) o.textContent = o.textContent + ' (Pro)';
        }
      });
      if (parseInt(qSel.value, 10) > FREE_QUESTION_LIMIT) qSel.value = String(FREE_QUESTION_LIMIT);
    }
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'freeTierNotice';
      notice.className = 'alert alert-tip';
      notice.style.cssText = 'margin-top:12px; padding:12px 14px; border-radius:10px; background:var(--blue-50, #eff6ff); border:1px solid var(--blue-200, #bfdbfe);';
      notice.innerHTML = `
        <strong>Mode Preview (Akun Biasa)</strong>
        <p class="muted" style="margin:4px 0 0; font-size:0.9rem;">Kamu bisa mencoba <strong>${FREE_QUESTION_LIMIT} soal</strong> per sesi. Pembahasan tiap soal & jumlah soal lebih banyak hanya tersedia di <strong>Akun Pro</strong>.</p>
      `;
      const startBtn = el('startBtn');
      if (startBtn && startBtn.parentNode) startBtn.parentNode.insertBefore(notice, startBtn);
    }
  }
  renderFreeTierNotice();
  // Re-render after auth completes (isPro may flip from false to true once profile loads).
  document.addEventListener('DOMContentLoaded', () => setTimeout(renderFreeTierNotice, 600));
  setTimeout(renderFreeTierNotice, 1500);

  function showStats() {
    const stats = App.getTbsStats();
    if (!stats.sessions.length) return;
    const last = stats.sessions[stats.sessions.length - 1];
    const avg = Math.round(stats.sessions.reduce((s, r) => s + r.percent, 0) / stats.sessions.length);
    const panel = el('progressStats');
    el('progressText').innerHTML = `Sesi terakhir: <strong>${last.percent}%</strong> (${last.correct}/${last.total}, ${last.category}) • Rata-rata: <strong>${avg}%</strong> dari ${stats.sessions.length} sesi`;
    panel.classList.remove('hidden');
  }
  showStats();

  el('startBtn').addEventListener('click', async () => {
    state.count = parseInt(el('qCount').value, 10);
    state.duration = parseInt(el('qTime').value, 10);
    // Free-tier hard cap (defense in depth — DOM gating is bypassable).
    if (!isPro() && state.count > FREE_QUESTION_LIMIT) state.count = FREE_QUESTION_LIMIT;
    const startBtn = el('startBtn');
    startBtn.disabled = true;
    const originalLabel = startBtn.textContent;
    startBtn.textContent = 'Memuat soal...';
    state.questions = await buildQuestions(state.category, state.count);
    startBtn.disabled = false;
    startBtn.textContent = originalLabel;
    if (!state.questions.length) {
      alert('Belum ada soal yang bisa dimuat. Coba kategori lain.');
      return;
    }
    state.answers = new Array(state.questions.length).fill(null);
    state.idx = 0;
    state.remaining = state.duration * 60;
    el('setupView').classList.add('hidden');
    el('quizView').classList.remove('hidden');
    el('resultView').classList.add('hidden');
    renderQuestion();
    startTimer();
  });

  // Build pool from Supabase if available; otherwise from local TBS_BANK.
  async function buildQuestions(cat, n) {
    let pool = [];
    if (window.App && App.isAuthEnabled && App.isAuthEnabled()) {
      try {
        const fetched = await App.fetchTbsQuestions(cat);
        pool = fetched.map(q => ({ ...q, _cat: q._cat || cat }));
      } catch (e) {
        console.warn('[LPDP Prep] fetchTbsQuestions failed; falling back to local bank.', e);
      }
    }
    if (!pool.length) {
      const bank = window.TBS_BANK;
      if (cat === 'campuran') {
        pool = [...bank.verbal, ...bank.numerik, ...bank.logika].map((q, i) => ({ ...q, _cat: guessCat(i, bank) }));
      } else {
        pool = (bank[cat] || []).map(q => ({ ...q, _cat: cat }));
      }
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.min(n, pool.length));
  }

  function guessCat(i, bank) {
    if (i < bank.verbal.length) return 'verbal';
    if (i < bank.verbal.length + bank.numerik.length) return 'numerik';
    return 'logika';
  }

  function renderQuestion() {
    const q = state.questions[state.idx];
    const card = el('questionCard');
    const answeredIdx = state.answers[state.idx];
    card.innerHTML = `
      <div class="q-num">Pertanyaan ${state.idx + 1} dari ${state.questions.length} • ${capitalize(q._cat)}</div>
      <div class="question-text">${q.q}</div>
      <div class="options">
        ${q.opts.map((opt, i) => `
          <label class="option ${answeredIdx === i ? 'selected' : ''}">
            <input type="radio" name="opt" value="${i}" ${answeredIdx === i ? 'checked' : ''} />
            <span><span class="option-label">${String.fromCharCode(65 + i)}.</span>${escapeHtml(opt)}</span>
          </label>
        `).join('')}
      </div>
    `;
    card.querySelectorAll('input[name="opt"]').forEach(inp => {
      inp.addEventListener('change', (e) => {
        state.answers[state.idx] = parseInt(e.target.value, 10);
        card.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
        e.target.closest('.option').classList.add('selected');
      });
    });

    el('qCat').textContent = capitalize(q._cat);
    el('qNumLabel').textContent = '• ' + (state.idx + 1) + '/' + state.questions.length;
    el('qProgress').style.width = ((state.idx + 1) / state.questions.length * 100) + '%';
    el('prevBtn').disabled = state.idx === 0;
    el('nextBtn').textContent = state.idx === state.questions.length - 1 ? 'Selesai & Lihat Skor' : 'Lanjut →';
  }

  el('nextBtn').addEventListener('click', () => {
    if (state.idx === state.questions.length - 1) {
      finish();
    } else {
      state.idx++;
      renderQuestion();
    }
  });
  el('prevBtn').addEventListener('click', () => {
    if (state.idx > 0) { state.idx--; renderQuestion(); }
  });
  el('skipBtn').addEventListener('click', () => {
    state.answers[state.idx] = null;
    if (state.idx === state.questions.length - 1) finish();
    else { state.idx++; renderQuestion(); }
  });

  function startTimer() {
    updateTimer();
    state.timerId = setInterval(() => {
      state.remaining--;
      updateTimer();
      if (state.remaining <= 0) {
        clearInterval(state.timerId);
        finish();
      }
    }, 1000);
  }
  function updTimerEl(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function updateTimer() {
    const tEl = el('timer');
    tEl.textContent = updTimerEl(state.remaining);
    if (state.remaining <= 60) tEl.classList.add('warn'); else tEl.classList.remove('warn');
  }

  function finish() {
    if (state.timerId) clearInterval(state.timerId);
    el('quizView').classList.add('hidden');
    el('resultView').classList.remove('hidden');
    let correct = 0;
    state.questions.forEach((q, i) => { if (state.answers[i] === q.a) correct++; });
    const total = state.questions.length;
    const percent = Math.round(correct / total * 100);

    // Per-category breakdown
    const byCat = {};
    state.questions.forEach((q, i) => {
      if (!byCat[q._cat]) byCat[q._cat] = { c: 0, t: 0 };
      byCat[q._cat].t++;
      if (state.answers[i] === q.a) byCat[q._cat].c++;
    });

    el('resultHero').style.setProperty('--pct', percent + '%');
    el('resultHero').innerHTML = `
      <div class="big-score">
        <div class="big-score-value">${percent}<small>/ 100</small></div>
      </div>
      <div>
        <h3>${percent >= 80 ? 'Luar Biasa!' : percent >= 60 ? 'Hasil Bagus' : percent >= 40 ? 'Perlu Latihan Lagi' : 'Yuk Latihan Lebih Banyak'}</h3>
        <p class="muted" style="margin:0">Kamu menjawab ${correct} dari ${total} soal dengan benar dalam ${updTimerEl(state.duration * 60 - state.remaining)}.</p>
      </div>
    `;
    el('resultMetrics').innerHTML = Object.entries(byCat).map(([cat, v]) =>
      `<div class="metric">
        <div class="metric-label"><span>${capitalize(cat)}</span><strong>${v.c}/${v.t}</strong></div>
        <div class="metric-bar"><span style="width:${Math.round(v.c/v.t*100)}%"></span></div>
      </div>`
    ).join('');

    // Review — pembahasan is Pro-only.
    const userIsPro = isPro();
    el('reviewList').innerHTML = state.questions.map((q, i) => {
      const chosen = state.answers[i];
      const isCorrect = chosen === q.a;
      const explanationHtml = userIsPro
        ? `<div class="explanation"><strong>Pembahasan:</strong> ${escapeHtml(q.exp || '')}</div>`
        : `<div class="explanation explanation-locked" style="background:var(--ink-50, #f5f7fa); border:1px dashed var(--ink-300, #cbd5e1); padding:10px 12px; border-radius:8px; color:var(--ink-700, #475569);">
             <strong>🔒 Pembahasan terkunci.</strong> Upgrade ke <strong>Akun Pro</strong> untuk melihat pembahasan tiap soal.
           </div>`;
      return `
        <div class="paragraph-card">
          <h5>Soal ${i + 1} <small class="muted">• ${capitalize(q._cat)}</small>
            ${chosen === null ? '<span class="tag tag-tip" style="margin-left:8px;">Tidak dijawab</span>' : (isCorrect ? '<span class="tag tag-strong" style="margin-left:8px;">Benar</span>' : '<span class="tag tag-weak" style="margin-left:8px;">Salah</span>')}
          </h5>
          <div style="margin:8px 0;">${escapeHtml(q.q)}</div>
          <div class="options" style="margin-bottom:10px;">
            ${q.opts.map((opt, oi) => {
              let cls = '';
              if (oi === q.a) cls = 'correct';
              else if (oi === chosen) cls = 'incorrect';
              return `<div class="option ${cls}" style="cursor:default"><span><span class="option-label">${String.fromCharCode(65+oi)}.</span>${escapeHtml(opt)}</span></div>`;
            }).join('')}
          </div>
          ${explanationHtml}
        </div>
      `;
    }).join('');

    // Save progress (local cache)
    const durationSec = state.duration * 60 - state.remaining;
    const stats = App.getTbsStats();
    stats.sessions.push({ date: Date.now(), category: state.category, correct, total, percent });
    App.saveTbsStats(stats);
    // Persist to DB if logged in
    App.saveTbsSessionToDb({ category: state.category, correct, total, percent, duration: durationSec });
  }

  el('retryBtn').addEventListener('click', () => {
    el('resultView').classList.add('hidden');
    el('setupView').classList.remove('hidden');
    showStats();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  el('reviewToggle').addEventListener('click', () => {
    const panel = el('reviewPanel');
    panel.classList.toggle('hidden');
    el('reviewToggle').textContent = panel.classList.contains('hidden') ? 'Lihat Pembahasan' : 'Sembunyikan Pembahasan';
  });

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
})();
