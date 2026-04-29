// Account page — shows profile, pro subscription status, and payment history.

(function () {
  const el = (id) => document.getElementById(id);

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('id-ID', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
    } catch { return iso; }
  }

  function fmtIDR(n) {
    return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID');
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  function statusBadge(s) {
    const map = {
      paid: { cls: 'tag-strong', label: 'Sukses' },
      pending: { cls: 'tag-tip', label: 'Menunggu' },
      denied: { cls: 'tag-weak', label: 'Ditolak' },
      expired: { cls: 'tag-weak', label: 'Kedaluwarsa' },
      refunded: { cls: 'tag-weak', label: 'Refund' },
    };
    const m = map[s] || { cls: 'tag-tip', label: s };
    return `<span class="tag ${m.cls}" style="font-size:0.75rem;">${m.label}</span>`;
  }

  async function boot() {
    let tries = 0;
    while (tries < 20 && App.isAuthEnabled() && !App.currentUser) {
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    el('loadingState').classList.add('hidden');

    if (!App.currentUser) {
      el('loginPrompt').classList.remove('hidden');
      return;
    }

    el('accountView').classList.remove('hidden');
    el('acctName').textContent = App.currentUser.name || '—';
    el('acctEmail').textContent = App.currentUser.email || '—';

    await renderProStatus();
    await renderPayments();
  }

  async function renderProStatus() {
    const wrap = el('proStatus');
    if (!window.sb) {
      wrap.innerHTML = '<p class="muted">Mode offline — langganan tidak tersedia.</p>';
      return;
    }
    try {
      const { data } = await window.sb
        .from('profiles')
        .select('is_pro, pro_plan, pro_started_at, pro_expires_at')
        .eq('id', App.currentUser.id)
        .maybeSingle();
      const isActive = data?.is_pro && data?.pro_expires_at &&
                       new Date(data.pro_expires_at) > new Date();
      if (isActive) {
        wrap.innerHTML = `
          <div class="account-row">
            <span class="muted">Status</span>
            <strong style="color: var(--green-600)">✓ Aktif <span class="pro-tag">PRO</span></strong>
          </div>
          <div class="account-row">
            <span class="muted">Paket</span>
            <strong>${escapeHtml(data.pro_plan || 'Pro')}</strong>
          </div>
          <div class="account-row">
            <span class="muted">Dimulai</span>
            <strong>${fmtDate(data.pro_started_at)}</strong>
          </div>
          <div class="account-row">
            <span class="muted">Berakhir</span>
            <strong>${fmtDate(data.pro_expires_at)}</strong>
          </div>
          <div style="margin-top:12px;">
            <a href="pricing.html" class="btn btn-ghost btn-sm">Perpanjang Lebih Awal</a>
          </div>
        `;
      } else if (data?.pro_expires_at && new Date(data.pro_expires_at) <= new Date()) {
        wrap.innerHTML = `
          <p class="muted" style="margin:0 0 12px;">Langganan Anda berakhir pada <strong>${fmtDate(data.pro_expires_at)}</strong>.</p>
          <a href="pricing.html" class="btn btn-primary">🔓 Perpanjang Pro</a>
        `;
      } else {
        wrap.innerHTML = `
          <p class="muted" style="margin:0 0 12px;">Akun gratis. Upgrade untuk membuka analisis mendalam dan feedback AI.</p>
          <a href="pricing.html" class="btn btn-primary">🔓 Upgrade ke Pro</a>
        `;
      }
    } catch (err) {
      console.warn('account pro status:', err);
      wrap.innerHTML = '<p class="muted">Gagal memuat status langganan.</p>';
    }
  }

  async function renderPayments() {
    const wrap = el('paymentsList');
    if (!window.sb) {
      wrap.innerHTML = '<p class="muted">—</p>';
      return;
    }
    try {
      const { data } = await window.sb
        .from('payments')
        .select('order_id, plan, amount_idr, status, payment_type, created_at')
        .order('created_at', { ascending: false })
        .limit(20);
      if (!data || !data.length) {
        wrap.innerHTML = '<p class="muted" style="margin:0">Belum ada pembayaran.</p>';
        return;
      }
      wrap.innerHTML = data.map(p => `
        <div class="paragraph-card" style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;">${fmtIDR(p.amount_idr)} <small class="muted" style="font-weight:400;">${escapeHtml(p.plan)}</small></div>
            <small class="muted">${escapeHtml(p.order_id)} • ${fmtDate(p.created_at)}${p.payment_type ? ' • ' + escapeHtml(p.payment_type) : ''}</small>
          </div>
          ${statusBadge(p.status)}
        </div>
      `).join('');
    } catch (err) {
      console.warn('account payments:', err);
      wrap.innerHTML = '<p class="muted">Gagal memuat riwayat.</p>';
    }
  }

  el('logoutBtn').addEventListener('click', () => App.logout());

  boot();
})();
