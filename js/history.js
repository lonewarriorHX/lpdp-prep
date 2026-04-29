// History controller — renders Essay / TBS / Interview history from Supabase

(function () {
  const el = (id) => document.getElementById(id);

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = months[d.getMonth()];
    const yy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2,'0');
    const mi = String(d.getMinutes()).padStart(2,'0');
    return `${dd} ${mm} ${yy}, ${hh}:${mi}`;
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
  function scoreColor(s) {
    if (s >= 80) return 'tag-strong';
    if (s >= 60) return 'tag-tip';
    return 'tag-weak';
  }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

  // Wait for auth to init before rendering
  async function boot() {
    // Give App.initAuth a moment (it runs on DOMContentLoaded)
    let tries = 0;
    while (tries < 20 && !App.currentUser && App.isAuthEnabled()) {
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }

    if (!App.currentUser) {
      el('loadingState').classList.add('hidden');
      el('loginPrompt').classList.remove('hidden');
      return;
    }

    const [essays, tbs, interviews] = await Promise.all([
      App.fetchEssayHistory(),
      App.fetchTbsHistory(),
      App.fetchInterviewHistory(),
    ]);

    el('loadingState').classList.add('hidden');
    el('historyView').classList.remove('hidden');

    renderCounts(essays.length, tbs.length, interviews.length);
    renderEssays(essays);
    renderTbs(tbs);
    renderInterviews(interviews);
  }

  function renderCounts(a, b, c) {
    el('countEssay').textContent = a ? '(' + a + ')' : '';
    el('countTbs').textContent = b ? '(' + b + ')' : '';
    el('countInterview').textContent = c ? '(' + c + ')' : '';
  }

  // -------- Tabs --------
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      ['essay','tbs','interview'].forEach(t => {
        el('pane' + capitalize(t)).classList.toggle('hidden', t !== tab);
      });
    });
  });

  // -------- Essay --------
  function renderEssays(items) {
    const wrap = el('essayList');
    if (!items.length) {
      wrap.innerHTML = emptyState('Belum ada essay yang dianalisis.', 'essay.html', 'Mulai Cek Essay');
      return;
    }
    wrap.innerHTML = items.map((it, i) => {
      const score = it.overall_score ?? 0;
      const titleBits = [];
      if (it.degree_level) titleBits.push(it.degree_level.toUpperCase());
      if (it.university_name) titleBits.push(it.university_name);
      if (it.language) titleBits.push(it.language === 'en' ? 'EN' : 'ID');
      const title = titleBits.length ? titleBits.join(' • ') : 'Essay';
      const covered = it.coverage ? Object.values(it.coverage).filter(c => c && c.present).length : null;
      const coverageBadge = covered != null ? `<span class="muted" style="font-size:0.8rem;">• ${covered}/3 aspek</span>` : '';
      return `
        <div class="paragraph-card" data-idx="${i}">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
            <div>
              <h5 style="margin-bottom:4px;">${escapeHtml(title)}</h5>
              <small class="muted">${fmtDate(it.created_at)} ${coverageBadge}</small>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="tag ${scoreColor(score)}" style="font-size:0.85rem; padding:4px 10px;">${score}/100</span>
              <button class="btn btn-ghost btn-sm" data-action="toggleEssay" data-idx="${i}" style="padding:6px 12px; font-size:0.85rem;">Detail</button>
              <button class="btn btn-ghost btn-sm" data-action="deleteEssay" data-id="${it.id}" style="padding:6px 12px; font-size:0.85rem; color:var(--red-500);">Hapus</button>
            </div>
          </div>
          <div class="essay-detail hidden" id="essayDetail-${i}" style="margin-top:14px;">
            ${renderEssayDetail(it)}
          </div>
        </div>
      `;
    }).join('');

    wrap.querySelectorAll('[data-action="toggleEssay"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = btn.dataset.idx;
        const d = el('essayDetail-' + idx);
        d.classList.toggle('hidden');
        btn.textContent = d.classList.contains('hidden') ? 'Detail' : 'Tutup';
      });
    });
    wrap.querySelectorAll('[data-action="deleteEssay"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Hapus essay ini? Tidak dapat dibatalkan.')) return;
        btn.disabled = true;
        const res = await App.deleteEssay(btn.dataset.id);
        if (res.ok) {
          btn.closest('.paragraph-card').remove();
          const remain = wrap.querySelectorAll('.paragraph-card').length;
          el('countEssay').textContent = remain ? '(' + remain + ')' : '';
          if (!remain) wrap.innerHTML = emptyState('Belum ada essay yang dianalisis.', 'essay.html', 'Mulai Cek Essay');
        } else {
          alert('Gagal menghapus essay.');
          btn.disabled = false;
        }
      });
    });
  }

  function essayTypeLabel(t) {
    return {
      kontribusi: 'Kontribusiku bagi Indonesia',
      sukses: 'Rencana Studi & Pasca Studi',
      motivasi: 'Motivasi & Komitmen',
    }[t] || t || 'Tidak diketahui';
  }

  function renderEssayDetail(it) {
    const a = it.analysis || {};
    const cov = it.coverage || a.coverage;
    const metrics = [
      ['Struktur', a.structure],
      ['Kejelasan', a.clarity],
      ['Dampak', a.impact],
      ['Cakupan Aspek', a.coverageAvg ?? a.relevance],
    ].filter(m => m[1] != null);
    const coverageHtml = cov ? `
      <div class="coverage-grid" style="margin-bottom:14px;">
        ${['kontribusi','rencana','motivasi'].map(k => {
          const c = cov[k];
          if (!c) return '';
          const cls = c.present ? 'covered' : 'missing';
          const icon = c.present ? '✓' : '✗';
          return `
            <div class="coverage-item coverage-${cls}">
              <div class="coverage-icon">${icon}</div>
              <div class="coverage-body">
                <div class="coverage-title">${escapeHtml(c.label || k)}</div>
                <div class="coverage-meta">${c.present ? 'Tercakup' : 'Belum'} • ${c.score || 0}/100</div>
                <div class="coverage-bar"><span style="width:${c.score || 0}%"></span></div>
              </div>
            </div>`;
        }).join('')}
      </div>` : '';
    return `
      ${coverageHtml}
      <div class="metrics" style="margin-bottom:16px;">
        ${metrics.map(([l, v]) => `
          <div class="metric">
            <div class="metric-label"><span>${l}</span><strong>${v}/100</strong></div>
            <div class="metric-bar"><span style="width:${v}%"></span></div>
          </div>
        `).join('')}
      </div>
      ${renderList('Kekuatan', a.strengths, 'tag-strong')}
      ${renderList('Kelemahan', a.weaknesses, 'tag-weak')}
      ${renderList('Saran', a.suggestions, 'tag-tip')}
      <details style="margin-top:12px;">
        <summary style="cursor:pointer; font-weight:600;">Tampilkan isi essay</summary>
        <div class="quote" style="margin-top:8px; white-space:pre-wrap;">${escapeHtml(it.content || '')}</div>
      </details>
    `;
  }
  function renderList(title, items, tag) {
    if (!items || !items.length) return '';
    return `
      <div class="analysis-block" style="margin-top:14px;">
        <h4><span class="tag ${tag}">${title}</span></h4>
        <ul>${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
      </div>
    `;
  }

  // -------- TBS --------
  function renderTbs(items) {
    const wrap = el('tbsList');
    const summary = el('tbsSummary');
    if (!items.length) {
      summary.innerHTML = '';
      wrap.innerHTML = emptyState('Belum ada sesi TBS.', 'tbs.html', 'Mulai Latihan TBS');
      return;
    }
    const avg = Math.round(items.reduce((s, i) => s + (i.percent || 0), 0) / items.length);
    const best = Math.max(...items.map(i => i.percent || 0));
    const totalQ = items.reduce((s, i) => s + (i.total_questions || 0), 0);
    const totalCorrect = items.reduce((s, i) => s + (i.correct || 0), 0);
    summary.innerHTML = `
      <div class="metric"><div class="metric-label"><span>Total Sesi</span><strong>${items.length}</strong></div></div>
      <div class="metric"><div class="metric-label"><span>Rata-rata</span><strong>${avg}%</strong></div><div class="metric-bar"><span style="width:${avg}%"></span></div></div>
      <div class="metric"><div class="metric-label"><span>Skor Terbaik</span><strong>${best}%</strong></div><div class="metric-bar"><span style="width:${best}%"></span></div></div>
      <div class="metric"><div class="metric-label"><span>Total Benar</span><strong>${totalCorrect}/${totalQ}</strong></div></div>
    `;

    wrap.innerHTML = items.map(it => {
      const pct = it.percent || 0;
      const mins = it.duration_seconds ? Math.floor(it.duration_seconds / 60) + 'm ' + (it.duration_seconds % 60) + 's' : '—';
      return `
        <div class="paragraph-card" style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
          <div>
            <h5 style="margin-bottom:4px;">Sesi ${capitalize(it.category || '')}</h5>
            <small class="muted">${fmtDate(it.created_at)} • durasi ${mins}</small>
          </div>
          <div style="display:flex; align-items:center; gap:14px;">
            <div style="text-align:right;">
              <div style="font-size:0.85rem; color:var(--ink-500);">${it.correct}/${it.total_questions} benar</div>
              <span class="tag ${scoreColor(pct)}" style="font-size:0.9rem; padding:4px 12px;">${pct}%</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // -------- Interview --------
  function renderInterviews(items) {
    const wrap = el('interviewList');
    if (!items.length) {
      wrap.innerHTML = emptyState('Belum ada simulasi wawancara.', 'interview.html', 'Mulai Interview');
      return;
    }
    wrap.innerHTML = items.map((it, i) => {
      const score = it.overall_score ?? 0;
      const qCount = Array.isArray(it.questions) ? it.questions.length : 0;
      return `
        <div class="paragraph-card">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
            <div>
              <h5 style="margin-bottom:4px;">Simulasi Wawancara</h5>
              <small class="muted">${fmtDate(it.created_at)} • ${qCount} pertanyaan</small>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="tag ${scoreColor(score)}" style="font-size:0.85rem; padding:4px 10px;">${score}/100</span>
              <button class="btn btn-ghost btn-sm" data-action="toggleItv" data-idx="${i}" style="padding:6px 12px; font-size:0.85rem;">Detail</button>
            </div>
          </div>
          <div class="itv-detail hidden" id="itvDetail-${i}" style="margin-top:14px;">
            ${renderInterviewDetail(it)}
          </div>
        </div>
      `;
    }).join('');

    wrap.querySelectorAll('[data-action="toggleItv"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = btn.dataset.idx;
        const d = el('itvDetail-' + idx);
        d.classList.toggle('hidden');
        btn.textContent = d.classList.contains('hidden') ? 'Detail' : 'Tutup';
      });
    });
  }

  function renderInterviewDetail(it) {
    const ev = it.evaluation || {};
    const fs = ev.focusScores || {};
    const focusLabels = {
      Clarity: 'Kejelasan', Motivation: 'Motivasi', Confidence: 'Kepercayaan Diri',
      Alignment: 'Kesesuaian Tujuan', Impact: 'Dampak', Relevance: 'Relevansi LPDP',
    };
    const metricsHtml = Object.entries(fs).map(([k, v]) => `
      <div class="metric">
        <div class="metric-label"><span>${focusLabels[k] || k}</span><strong>${v}/100</strong></div>
        <div class="metric-bar"><span style="width:${v}%"></span></div>
      </div>
    `).join('');

    const qa = (it.questions || []).map((q, idx) => {
      const ans = (it.answers || [])[idx] || '';
      return `
        <div class="bubble bubble-q"><small>Q${idx+1}</small>${escapeHtml(q.q || '')}</div>
        <div class="bubble bubble-a"><small>Jawabanmu</small>${ans ? escapeHtml(ans) : '<em>(tidak dijawab)</em>'}</div>
      `;
    }).join('');

    return `
      ${metricsHtml ? `<div class="metrics" style="margin-bottom:14px;">${metricsHtml}</div>` : ''}
      ${renderList('Kekuatan', ev.strengths, 'tag-strong')}
      ${renderList('Area Perbaikan', ev.weaknesses, 'tag-weak')}
      ${renderList('Saran', ev.suggestions, 'tag-tip')}
      <details style="margin-top:12px;">
        <summary style="cursor:pointer; font-weight:600;">Tampilkan transkrip</summary>
        <div class="chat" style="margin-top:10px; max-height:420px;">${qa}</div>
      </details>
    `;
  }

  function emptyState(msg, href, cta) {
    return `
      <div style="text-align:center; padding:40px 20px;">
        <p class="muted">${msg}</p>
        <a href="${href}" class="btn btn-primary" style="margin-top:12px;">${cta}</a>
      </div>
    `;
  }

  boot();
})();
