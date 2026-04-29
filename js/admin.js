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
    if (!App.currentUser) {
      el('loadingState').classList.add('hidden');
      el('loginPrompt').classList.remove('hidden');
      return;
    }
    el('loadingState').classList.add('hidden');
    el('adminView').classList.remove('hidden');
    await refreshList();
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

  boot();
})();
