// Admin — manage reference essays (winning LPDP essays used as training corpus)

(function () {
  const el = (id) => document.getElementById(id);
  const content = el('refContent');
  const wordsEl = el('refWords');
  let refEssays = [];

  content.addEventListener('input', () => {
    const t = content.value.trim();
    wordsEl.textContent = t ? t.split(/\s+/).length : 0;
  });

  function showAlert(msg, type) {
    el('refAlert').innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
    if (type === 'success') setTimeout(() => el('refAlert').innerHTML = '', 2500);
  }

  async function boot() {
    let tries = 0;
    while (tries < 20 && !App.currentUser && App.isAuthEnabled()) {
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    el('loadingState').classList.add('hidden');
    if (!App.currentUser) {
      el('loginPrompt').classList.remove('hidden');
      return;
    }
    // Pull a fresh profile snapshot so newly-approved alumni see the right gate.
    if (typeof App._refreshProStatus === 'function') {
      await App._refreshProStatus();
    }
    // Super-admins bypass the alumni gate
    if (App.isAdmin) {
      showAdmin();
      await refreshList();
      if (typeof refreshQuestionList === 'function') await refreshQuestionList();
      return;
    }
    if (!App.getIsAlumni || !App.getIsAlumni()) {
      renderAlumniGate();
      return;
    }
    showAdmin();
    await refreshList();
    if (typeof refreshQuestionList === 'function') await refreshQuestionList();
  }

  function showAdmin() {
    el('adminView').classList.remove('hidden');
    const promo = el('alumniPromoCodeDisplay');
    if (promo) promo.textContent = App.alumniPromoCode || 'belum ditetapkan';
    // Show AI Settings tab for admin users
    if (App.isAdmin) {
      const tab = el('aiSettingsTab');
      if (tab) tab.classList.remove('hidden');
    }
  }

  function renderAlumniGate() {
    const gate = el('alumniGate');
    const noneEl = el('alumniGateNone');
    const pendingEl = el('alumniGatePending');
    const rejectedEl = el('alumniGateRejected');
    if (!gate || !noneEl || !pendingEl || !rejectedEl) return;
    gate.classList.remove('hidden');
    noneEl.classList.add('hidden');
    pendingEl.classList.add('hidden');
    rejectedEl.classList.add('hidden');

    const status = App.getAlumniStatus ? App.getAlumniStatus() : 'none';
    if (status === 'pending') {
      pendingEl.classList.remove('hidden');
      const u = el('alumniSubmittedUni');
      const y = el('alumniSubmittedYear');
      if (u) u.textContent = App.alumniUniversity || '—';
      if (y) y.textContent = App.alumniYear || '—';
    } else if (status === 'rejected') {
      rejectedEl.classList.remove('hidden');
    } else {
      noneEl.classList.remove('hidden');
    }
  }

  async function submitAlumniRequest() {
    const btn = el('submitAlumniReqBtn');
    const alertEl = el('alumniReqAlert');
    const university = el('alumniUniversity').value.trim();
    const year = el('alumniYear').value.trim();
    const notes = el('alumniNotes').value.trim();
    if (!university || !notes) {
      alertEl.innerHTML = '<div class="alert alert-warning">Harap isi minimal universitas dan catatan verifikasi.</div>';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Mengirim...';
    const res = await App.submitAlumniRequest({ university, year, notes });
    btn.disabled = false;
    btn.textContent = 'Kirim Permintaan Verifikasi';
    if (!res.ok) {
      alertEl.innerHTML = `<div class="alert alert-error">${res.error || 'Gagal mengirim permintaan.'}</div>`;
      return;
    }
    alertEl.innerHTML = '';
    renderAlumniGate();
  }

  async function refreshList() {
    refEssays = await App.fetchReferenceEssays();
    render(refEssays);
  }

  function render(items) {
    el('refCount').textContent = items.length ? `(${items.length})` : '';
    const list = el('refList');
    if (!items.length) {
      list.innerHTML = '<p class="muted" style="text-align:center; padding:24px;">Belum ada essay referensi.</p>';
      return;
    }
    list.innerHTML = items.map(it => {
      const ownerBadge = App.currentUser && it.user_id === App.currentUser.id ? '' : '<span class="tag tag-tip" style="font-size:0.7rem;">orang lain</span>';
      return `
        <div class="paragraph-card">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
            <div style="flex:1; min-width:200px;">
              <h5 style="margin-bottom:2px;">${escapeHtml(it.title || 'Untitled')}</h5>
              <small class="muted">
                ${(it.language || 'id').toUpperCase()}
                ${it.degree_level ? ' • ' + it.degree_level.toUpperCase() : ''}
                ${it.university_name ? ' • ' + escapeHtml(it.university_name) : ''}
                ${it.author ? ' • ' + escapeHtml(it.author) : ''}
              </small>
              ${it.tags && it.tags.length ? '<div style="margin-top:4px;">' + it.tags.map(t => `<span class="tag tag-tip" style="margin-right:4px; font-size:0.7rem;">${escapeHtml(t)}</span>`).join('') + '</div>' : ''}
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
              ${ownerBadge}
              <button class="btn btn-ghost btn-sm" data-action="preview" data-id="${it.id}" style="padding:4px 10px; font-size:0.8rem;">Preview</button>
              ${App.currentUser && it.user_id === App.currentUser.id ? `<button class="btn btn-ghost btn-sm" data-action="delete" data-id="${it.id}" style="padding:4px 10px; font-size:0.8rem; color:var(--red-500);">Hapus</button>` : ''}
            </div>
          </div>
          <div class="ref-preview hidden" id="refPreview-${it.id}" style="margin-top:10px;">
            <div class="quote" style="white-space:pre-wrap;">${escapeHtml(it.content)}</div>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('[data-action="preview"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = el('refPreview-' + btn.dataset.id);
        p.classList.toggle('hidden');
        btn.textContent = p.classList.contains('hidden') ? 'Preview' : 'Tutup';
      });
    });
    list.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Hapus essay referensi ini?')) return;
        btn.disabled = true;
        const res = await App.deleteReferenceEssay(btn.dataset.id);
        if (res.ok) await refreshList();
        else { alert('Gagal menghapus.'); btn.disabled = false; }
      });
    });
  }

  el('refFilter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) return render(refEssays);
    render(refEssays.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.university_name || '').toLowerCase().includes(q) ||
      (r.author || '').toLowerCase().includes(q) ||
      (r.tags || []).join(' ').toLowerCase().includes(q)
    ));
  });

  el('saveRefBtn').addEventListener('click', async () => {
    const title = el('refTitle').value.trim();
    const body = content.value.trim();
    if (!title) return showAlert('Judul wajib diisi.', 'error');
    if (body.split(/\s+/).filter(Boolean).length < 150) {
      return showAlert('Isi essay terlalu pendek (minimal 150 kata).', 'error');
    }
    const tags = el('refTags').value.split(',').map(t => t.trim()).filter(Boolean);
    const btn = el('saveRefBtn');
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    const res = await App.saveReferenceEssay({
      title,
      content: body,
      language: el('refLanguage').value,
      degreeLevel: el('refDegree').value || null,
      universityLocation: el('refLocation').value || null,
      universityName: el('refUniversity').value.trim() || null,
      author: el('refAuthor').value.trim() || null,
      tags: tags.length ? tags : null,
    });
    btn.disabled = false; btn.textContent = 'Simpan Essay Referensi';
    if (!res.ok) return showAlert(res.error?.message || 'Gagal menyimpan.', 'error');
    showAlert('Essay referensi tersimpan.', 'success');
    // reset
    el('refTitle').value = '';
    content.value = '';
    wordsEl.textContent = '0';
    el('refAuthor').value = '';
    el('refTags').value = '';
    el('refUniversity').value = '';
    await refreshList();
  });

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  // ---------------- Tabs ----------------
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.admin-tab-panel').forEach(p => {
        p.classList.toggle('hidden', p.dataset.panel !== target);
      });
      if (target === 'questions' && App.currentUser) refreshQuestionList();
      if (target === 'ai-settings' && App.isAdmin) refreshAiProviderList();
    });
  });

  // ---------------- Reference questions ----------------
  let refQuestions = [];

  async function refreshQuestionList() {
    refQuestions = await App.fetchReferenceQuestions();
    renderQuestions(refQuestions);
  }

  function renderQuestions(items) {
    el('rqCount').textContent = items.length ? `(${items.length})` : '';
    const list = el('rqList');
    if (!items.length) {
      list.innerHTML = '<p class="muted" style="text-align:center; padding:24px;">Belum ada pertanyaan referensi. Tambahkan beberapa untuk mengisi AI dengan contoh.</p>';
      return;
    }
    list.innerHTML = items.map(it => {
      const ownerBadge = App.currentUser && it.user_id === App.currentUser.id ? '' : '<span class="tag tag-tip" style="font-size:0.7rem;">orang lain</span>';
      return `
        <div class="paragraph-card">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
            <div style="flex:1; min-width:200px;">
              <div style="font-weight:600; margin-bottom:4px;">${escapeHtml(it.question)}</div>
              <small class="muted">
                ${(it.language || 'id').toUpperCase()}
                ${it.focus ? ' • Fokus: ' + escapeHtml(it.focus) : ''}
                ${it.notes ? ' • ' + escapeHtml(it.notes) : ''}
              </small>
              ${it.tags && it.tags.length ? '<div style="margin-top:4px;">' + it.tags.map(t => `<span class="tag tag-tip" style="margin-right:4px; font-size:0.7rem;">${escapeHtml(t)}</span>`).join('') + '</div>' : ''}
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
              ${ownerBadge}
              ${App.currentUser && it.user_id === App.currentUser.id ? `<button class="btn btn-ghost btn-sm" data-action="rq-delete" data-id="${it.id}" style="padding:4px 10px; font-size:0.8rem; color:var(--red-500);">Hapus</button>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('[data-action="rq-delete"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Hapus pertanyaan referensi ini?')) return;
        btn.disabled = true;
        const res = await App.deleteReferenceQuestion(btn.dataset.id);
        if (res.ok) await refreshQuestionList();
        else { alert('Gagal menghapus.'); btn.disabled = false; }
      });
    });
  }

  el('rqFilter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) return renderQuestions(refQuestions);
    renderQuestions(refQuestions.filter(r =>
      (r.question || '').toLowerCase().includes(q) ||
      (r.focus || '').toLowerCase().includes(q) ||
      (r.notes || '').toLowerCase().includes(q) ||
      (r.tags || []).join(' ').toLowerCase().includes(q)
    ));
  });

  function showRqAlert(msg, type) {
    el('rqAlert').innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
    if (type === 'success') setTimeout(() => el('rqAlert').innerHTML = '', 2500);
  }

  el('saveRqBtn').addEventListener('click', async () => {
    const question = el('rqQuestion').value.trim();
    if (question.length < 10) return showRqAlert('Pertanyaan terlalu pendek.', 'error');
    const tags = el('rqTags').value.split(',').map(t => t.trim()).filter(Boolean);
    const btn = el('saveRqBtn');
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    const res = await App.saveReferenceQuestion({
      question,
      focus: el('rqFocus').value || null,
      language: el('rqLanguage').value,
      notes: el('rqNotes').value.trim() || null,
      tags: tags.length ? tags : null,
    });
    btn.disabled = false; btn.textContent = 'Simpan Pertanyaan Referensi';
    if (!res.ok) return showRqAlert(res.error?.message || 'Gagal menyimpan.', 'error');
    showRqAlert('Pertanyaan referensi tersimpan.', 'success');
    el('rqQuestion').value = '';
    el('rqNotes').value = '';
    el('rqTags').value = '';
    await refreshQuestionList();
  });

  const submitBtn = el('submitAlumniReqBtn');
  if (submitBtn) submitBtn.addEventListener('click', submitAlumniRequest);

  // ---------------- AI Providers (admin only) ----------------
  let aiProviders = [];

  async function refreshAiProviderList() {
    aiProviders = await App.fetchAiProviders();
    renderAiProviders(aiProviders);
  }

  function showAiAlert(msg, type) {
    const a = el('aiAlert');
    if (!a) return;
    a.innerHTML = '<div class="alert alert-' + type + '">' + msg + '</div>';
    if (type === 'success') setTimeout(function() { a.innerHTML = ''; }, 2500);
  }

  function maskKey(key) {
    if (!key || key.length < 8) return '••••••••';
    return '••••••••' + key.slice(-4);
  }

  function renderAiProviders(items) {
    var countEl = el('aiCount');
    if (countEl) countEl.textContent = items.length ? '(' + items.length + ')' : '';
    var list = el('aiList');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<p class="muted" style="text-align:center; padding:24px;">Belum ada AI provider. Tambahkan minimal satu provider agar fitur AI berjalan.</p>';
      return;
    }
    list.innerHTML = items.map(function(p) {
      var typeBadge = p.provider_type === 'anthropic'
        ? '<span class="tag" style="background:#ede9fe; color:#6d28d9; font-size:0.7rem;">Anthropic</span>'
        : '<span class="tag" style="background:#dbeafe; color:#1d4ed8; font-size:0.7rem;">OpenAI-Compatible</span>';
      var statusDot = p.is_active
        ? '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--green-500); margin-right:6px;" title="Aktif"></span>'
        : '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--ink-400); margin-right:6px;" title="Nonaktif"></span>';
      return '<div class="paragraph-card">' +
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">' +
          '<div style="flex:1; min-width:200px;">' +
            '<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">' +
              statusDot +
              '<h5 style="margin:0;">' + escapeHtml(p.name) + '</h5>' +
              typeBadge +
              '<span class="muted" style="font-size:0.75rem;">P' + (p.priority ?? 0) + '</span>' +
            '</div>' +
            '<small class="muted">' +
              escapeHtml(p.model) + ' &middot; ' + escapeHtml(p.api_base_url) +
            '</small><br/>' +
            '<small class="muted">Key: <code style="font-size:0.8rem;">' + maskKey(p.api_key) + '</code>' +
            ' &middot; max_tokens: ' + (p.max_tokens || 2500) +
            ' &middot; temp: ' + (p.temperature ?? 0.3) + '</small>' +
          '</div>' +
          '<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">' +
            '<button class="btn btn-ghost btn-sm" data-action="ai-try" data-id="' + p.id + '" style="padding:4px 10px; font-size:0.8rem; color:var(--blue-600);">Try</button>' +
            '<button class="btn btn-ghost btn-sm" data-action="ai-toggle" data-id="' + p.id + '" data-active="' + (p.is_active ? '1' : '0') + '" style="padding:4px 10px; font-size:0.8rem;">' + (p.is_active ? 'Nonaktifkan' : 'Aktifkan') + '</button>' +
            '<button class="btn btn-ghost btn-sm" data-action="ai-edit" data-id="' + p.id + '" style="padding:4px 10px; font-size:0.8rem;">Edit</button>' +
            '<button class="btn btn-ghost btn-sm" data-action="ai-delete" data-id="' + p.id + '" style="padding:4px 10px; font-size:0.8rem; color:var(--red-500);">Hapus</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    list.querySelectorAll('[data-action="ai-try"]').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        btn.disabled = true;
        var origText = btn.textContent;
        btn.textContent = '...';
        try {
          var r = await window.sb.functions.invoke('test-provider', { body: { provider_id: btn.dataset.id } });
          var data = r.data || {};
          if (data.ok) {
            btn.textContent = data.durationMs + 'ms';
            btn.style.color = 'var(--green-600)';
          } else {
            btn.textContent = 'Fail';
            btn.style.color = 'var(--red-500)';
            btn.title = data.error || 'Failed';
          }
        } catch (e) {
          btn.textContent = 'Err';
          btn.style.color = 'var(--red-500)';
        }
        setTimeout(function() { btn.textContent = origText; btn.style.color = 'var(--blue-600)'; btn.disabled = false; }, 3000);
      });
    });
    list.querySelectorAll('[data-action="ai-toggle"]').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var active = btn.dataset.active === '1';
        btn.disabled = true;
        var res = await App.toggleAiProvider(btn.dataset.id, !active);
        if (res.ok) await refreshAiProviderList();
        else { alert('Gagal mengubah status.'); btn.disabled = false; }
      });
    });
    list.querySelectorAll('[data-action="ai-edit"]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var p = aiProviders.find(function(x) { return x.id === btn.dataset.id; });
        if (!p) return;
        el('aiEditId').value = p.id;
        el('aiName').value = p.name;
        el('aiType').value = p.provider_type;
        el('aiBaseUrl').value = p.api_base_url;
        el('aiApiKey').value = '';
        el('aiModel').value = p.model;
        el('aiPriority').value = p.priority ?? 0;
        el('aiMaxTokens').value = p.max_tokens ?? 2500;
        el('aiTemperature').value = p.temperature ?? 0.3;
        el('saveAiBtn').textContent = 'Update Provider';
        el('cancelAiEditBtn').classList.remove('hidden');
        el('aiKeyHint').textContent = 'Kosongkan untuk tetap pakai key lama: ' + maskKey(p.api_key);
        updateAiHints();
      });
    });
    list.querySelectorAll('[data-action="ai-delete"]').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        if (!confirm('Hapus AI provider ini?')) return;
        btn.disabled = true;
        var res = await App.deleteAiProvider(btn.dataset.id);
        if (res.ok) await refreshAiProviderList();
        else { alert('Gagal menghapus.'); btn.disabled = false; }
      });
    });
  }

  function resetAiForm() {
    el('aiEditId').value = '';
    el('aiName').value = '';
    el('aiType').value = 'openai_compatible';
    el('aiBaseUrl').value = '';
    el('aiApiKey').value = '';
    el('aiModel').value = '';
    el('aiPriority').value = '0';
    el('aiMaxTokens').value = '2500';
    el('aiTemperature').value = '0.30';
    el('saveAiBtn').textContent = 'Simpan Provider';
    el('cancelAiEditBtn').classList.add('hidden');
    el('aiKeyHint').textContent = '';
    updateAiHints();
  }

  function updateAiHints() {
    var type = el('aiType') ? el('aiType').value : 'openai_compatible';
    var urlHint = el('aiBaseUrlHint');
    var modelHint = el('aiModelHint');
    if (type === 'anthropic') {
      if (urlHint) urlHint.innerHTML = 'Direct: <code>https://api.anthropic.com</code><br/>CF Gateway: <code>https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic</code>';
      if (modelHint) modelHint.textContent = 'Contoh: claude-sonnet-4-20250514, claude-haiku-4-5-20251001';
      if (!el('aiBaseUrl').value && !el('aiEditId').value) el('aiBaseUrl').value = 'https://api.anthropic.com';
    } else if (type === 'cloudflare_ai') {
      if (urlHint) urlHint.innerHTML = 'Format: <code>https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run</code><br/>Tambahkan <code>cf-aig-gateway-id</code> di extra headers jika pakai gateway.';
      if (modelHint) modelHint.innerHTML = 'Format: <code>provider/model</code>. Contoh: <code>google/gemini-3.5-flash</code>, <code>openai/gpt-4.1-nano</code>, <code>@cf/meta/llama-3.3-70b-instruct-fp8-fast</code><br/><a href="https://developers.cloudflare.com/ai/models/" target="_blank" style="font-size:0.8rem;">Lihat semua model &rarr;</a>';
      if (!el('aiBaseUrl').value && !el('aiEditId').value) el('aiBaseUrl').value = '';
    } else {
      if (urlHint) urlHint.innerHTML = 'Direct: <code>https://api.openai.com/v1</code> · <code>https://openrouter.ai/api/v1</code><br/>CF Gateway: <code>https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai</code>';
      if (modelHint) modelHint.textContent = 'Contoh: gpt-4o, gpt-4o-mini, openai/gpt-oss-120b:free';
      if (!el('aiBaseUrl').value && !el('aiEditId').value) el('aiBaseUrl').value = '';
    }
  }

  // Type selector changes hints
  var aiTypeSelect = el('aiType');
  if (aiTypeSelect) aiTypeSelect.addEventListener('change', updateAiHints);

  // Cancel edit
  var cancelBtn = el('cancelAiEditBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', resetAiForm);

  // Save provider
  var saveAiBtn = el('saveAiBtn');
  if (saveAiBtn) saveAiBtn.addEventListener('click', async function() {
    var name = (el('aiName').value || '').trim();
    var apiBaseUrl = (el('aiBaseUrl').value || '').trim();
    var model = (el('aiModel').value || '').trim();
    var apiKey = (el('aiApiKey').value || '').trim();
    var editId = (el('aiEditId').value || '').trim();

    if (!name) return showAiAlert('Nama provider wajib diisi.', 'error');
    if (!apiBaseUrl) return showAiAlert('Base URL wajib diisi.', 'error');
    if (!model) return showAiAlert('Model wajib diisi.', 'error');
    if (!editId && !apiKey) return showAiAlert('API Key wajib diisi untuk provider baru.', 'error');

    saveAiBtn.disabled = true;
    saveAiBtn.textContent = 'Menyimpan...';
    var res = await App.saveAiProvider({
      id: editId || undefined,
      name: name,
      providerType: el('aiType').value,
      apiBaseUrl: apiBaseUrl,
      apiKey: apiKey || undefined,
      model: model,
      isActive: true,
      priority: parseInt(el('aiPriority').value, 10) || 0,
      maxTokens: parseInt(el('aiMaxTokens').value, 10) || 2500,
      temperature: parseFloat(el('aiTemperature').value) || 0.3,
      extraHeaders: {},
    });
    saveAiBtn.disabled = false;
    saveAiBtn.textContent = editId ? 'Update Provider' : 'Simpan Provider';
    if (!res.ok) return showAiAlert((res.error && res.error.message) || 'Gagal menyimpan.', 'error');
    showAiAlert(editId ? 'Provider berhasil diupdate.' : 'Provider berhasil disimpan.', 'success');
    resetAiForm();
    await refreshAiProviderList();
  });

  // Try provider (from form — before saving)
  var tryAiBtn = el('tryAiBtn');
  if (tryAiBtn) tryAiBtn.addEventListener('click', async function() {
    var resultEl = el('aiTryResult');
    var apiBaseUrl = (el('aiBaseUrl').value || '').trim();
    var model = (el('aiModel').value || '').trim();
    var apiKey = (el('aiApiKey').value || '').trim();
    var editId = (el('aiEditId').value || '').trim();

    if (!apiBaseUrl || !model) return showAiAlert('Base URL dan Model wajib diisi untuk test.', 'error');
    if (!apiKey && !editId) return showAiAlert('API Key wajib diisi untuk test provider baru.', 'error');

    tryAiBtn.disabled = true;
    tryAiBtn.textContent = 'Testing...';
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = '<div class="alert" style="background:var(--blue-50); color:var(--blue-700);">Mengirim test request...</div>';

    try {
      var body = editId && !apiKey
        ? { provider_id: editId }
        : { provider_type: el('aiType').value, api_base_url: apiBaseUrl, api_key: apiKey, model: model, extra_headers: {} };
      var r = await window.sb.functions.invoke('test-provider', { body: body });
      var data = r.data || {};
      if (data.ok) {
        resultEl.innerHTML = '<div class="alert alert-success">OK (' + (data.durationMs || '?') + 'ms) — ' + escapeHtml((data.response || '').slice(0, 150)) + '</div>';
      } else {
        resultEl.innerHTML = '<div class="alert alert-error">Gagal: ' + escapeHtml(data.error || 'Unknown error') + '</div>';
      }
    } catch (e) {
      resultEl.innerHTML = '<div class="alert alert-error">Error: ' + escapeHtml(e.message || String(e)) + '</div>';
    }
    tryAiBtn.disabled = false;
    tryAiBtn.textContent = 'Try';
  });

  boot();
})();
