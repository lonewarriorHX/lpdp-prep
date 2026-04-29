// Pricing page — handles Midtrans Snap checkout

(function () {
  const el = (id) => document.getElementById(id);

  function showAlert(msg, type) {
    el('payAlert').innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('id-ID', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
    } catch { return iso; }
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

    // Check if already pro & active
    if (window.sb) {
      try {
        const { data } = await window.sb
          .from('profiles')
          .select('is_pro, pro_expires_at')
          .eq('id', App.currentUser.id)
          .maybeSingle();
        if (data?.is_pro && data?.pro_expires_at &&
            new Date(data.pro_expires_at) > new Date()) {
          el('proExpiresLabel').textContent = fmtDate(data.pro_expires_at);
          el('alreadyPro').classList.remove('hidden');
          return;
        }
      } catch (err) { console.warn('pricing pro check:', err); }
    }

    el('pricingView').classList.remove('hidden');
  }

  el('upgradeBtn').addEventListener('click', async () => {
    const btn = el('upgradeBtn');
    if (!App.currentUser) {
      window.location.href = 'login.html';
      return;
    }
    if (!window.snap) {
      showAlert('Midtrans Snap belum dimuat. Pastikan koneksi internet stabil dan refresh halaman.', 'error');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Memproses...';
    showAlert('Membuat order...', 'info');

    try {
      const { data: { session } } = await window.sb.auth.getSession();
      const jwt = session?.access_token;
      if (!jwt) throw new Error('Sesi tidak valid. Coba login ulang.');

      const url = `${window.SUPABASE_CONFIG.url}/functions/v1/create-payment`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
          'apikey': window.SUPABASE_CONFIG.anonKey,
        },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Gagal membuat order.');

      el('payAlert').innerHTML = '';
      btn.disabled = false;
      btn.textContent = '🔓 Upgrade ke Pro';

      window.snap.pay(data.snap_token, {
        onSuccess: function (result) {
          showAlert('Pembayaran berhasil! Akun Anda akan aktif sebagai Pro dalam beberapa detik.', 'success');
          setTimeout(() => { window.location.href = 'account.html'; }, 2500);
        },
        onPending: function (result) {
          showAlert('Pembayaran menunggu konfirmasi. Akun akan aktif setelah pembayaran selesai.', 'info');
        },
        onError: function (result) {
          showAlert('Pembayaran gagal: ' + (result?.status_message || 'Unknown error'), 'error');
          console.error('Snap error:', result);
        },
        onClose: function () {
          // user closed popup without paying — silent
        },
      });
    } catch (err) {
      console.error(err);
      showAlert('Error: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = '🔓 Upgrade ke Pro';
    }
  });

  boot();
})();
