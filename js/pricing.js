// Pricing page — handles Midtrans Snap checkout

(function () {
  const el = (id) => document.getElementById(id);

  // ===== Pricing config (display only — backend amount is in create-payment) =====
  const PRICES = {
    earlyBird: 49900,
    transactionFee: 2500,
  };
  const COUPONS = {
    HANXA: { discount: 10000, label: 'HANXA', desc: 'Diskon Rp 10.000' },
  };
  let appliedCoupon = null; // { code, discount, label }

  function fmtIDR(n) {
    return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID');
  }

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

  function recalcTotal() {
    const subtotal = PRICES.earlyBird;
    const fee = PRICES.transactionFee;
    const discount = appliedCoupon ? appliedCoupon.discount : 0;
    const total = Math.max(0, subtotal + fee - discount);
    el('coSubtotal').textContent = fmtIDR(subtotal);
    el('coFee').textContent = '+ ' + fmtIDR(fee);
    el('coTotal').textContent = fmtIDR(total);
    if (appliedCoupon) {
      el('coDiscountRow').classList.remove('hidden');
      el('coCouponLabel').textContent = appliedCoupon.label;
      el('coDiscount').textContent = '– ' + fmtIDR(appliedCoupon.discount);
    } else {
      el('coDiscountRow').classList.add('hidden');
    }
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
    recalcTotal();
    await renderPromoCounter();
  }

  async function renderPromoCounter() {
    if (!window.sb) return;
    try {
      const { data, error } = await window.sb.rpc('promo_pro_count');
      if (error) { console.warn('promo_pro_count error:', error); return; }
      const used = Math.max(0, Math.min(100, Number(data) || 0));
      const remaining = Math.max(0, 100 - used);
      const pct = (used / 100) * 100;
      el('promoUsed').textContent = used;
      el('promoRemaining').textContent = remaining + ' tersisa';
      el('promoCounterFill').style.width = pct + '%';

      // If promo full → disable promo card, enable regular card
      if (remaining <= 0) {
        const promoBtn = el('upgradeBtn');
        promoBtn.disabled = true;
        promoBtn.textContent = 'Kuota Promo Habis';
        el('promoCard').classList.add('pricing-card--soldout');
        const regBtn = el('regularBtn');
        if (regBtn) {
          regBtn.disabled = false;
          regBtn.textContent = '🔓 Upgrade ke Pro';
          regBtn.classList.remove('btn-ghost');
          regBtn.classList.add('btn-primary');
          el('regularCard').classList.add('pricing-card--featured');
        }
      }
    } catch (err) {
      console.warn('promo counter:', err);
    }
  }

  // ===== Step 1: Click Upgrade → show checkout panel =====
  el('upgradeBtn').addEventListener('click', () => {
    if (!App.currentUser) {
      window.location.href = 'login.html';
      return;
    }
    el('checkoutPanel').classList.remove('hidden');
    el('checkoutPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    el('couponInput').value = '';
    appliedCoupon = null;
    el('couponMsg').textContent = '';
    el('couponMsg').className = 'muted';
    el('couponMsg').style.fontSize = '0.85rem';
    el('couponMsg').style.marginTop = '6px';
    recalcTotal();
  });

  // ===== Step 2: Cancel checkout =====
  el('cancelCheckoutBtn').addEventListener('click', () => {
    el('checkoutPanel').classList.add('hidden');
    el('payAlert').innerHTML = '';
  });

  // ===== Step 3: Apply coupon =====
  el('applyCouponBtn').addEventListener('click', () => {
    const code = (el('couponInput').value || '').trim().toUpperCase();
    const msg = el('couponMsg');
    if (!code) {
      appliedCoupon = null;
      msg.textContent = 'Masukkan kode terlebih dahulu.';
      msg.style.color = 'var(--ink-500)';
      recalcTotal();
      return;
    }
    const c = COUPONS[code];
    if (!c) {
      appliedCoupon = null;
      msg.textContent = '✗ Kode promo tidak valid.';
      msg.style.color = 'var(--red-500)';
      recalcTotal();
      return;
    }
    appliedCoupon = { code, discount: c.discount, label: c.label };
    msg.innerHTML = `✓ Kode <strong>${code}</strong> diterapkan — ${c.desc}.`;
    msg.style.color = 'var(--green-600)';
    recalcTotal();
  });
  // Allow Enter to apply
  el('couponInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el('applyCouponBtn').click(); }
  });

  // ===== Step 4: Confirm and pay via Midtrans =====
  el('confirmPayBtn').addEventListener('click', async () => {
    const btn = el('confirmPayBtn');
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
        // Body fields are sent for the day backend honors them. Backend
        // currently uses a fixed amount in create-payment/index.ts.
        body: JSON.stringify({
          coupon_code: appliedCoupon?.code ?? null,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Gagal membuat order.');

      el('payAlert').innerHTML = '';
      btn.disabled = false;
      btn.textContent = 'Bayar via Midtrans';

      window.snap.pay(data.snap_token, {
        onSuccess: function () {
          showAlert('Pembayaran berhasil! Akun Anda akan aktif sebagai Pro dalam beberapa detik.', 'success');
          setTimeout(() => { window.location.href = 'account.html'; }, 2500);
        },
        onPending: function () {
          showAlert('Pembayaran menunggu konfirmasi. Akun akan aktif setelah pembayaran selesai.', 'info');
        },
        onError: function (result) {
          showAlert('Pembayaran gagal: ' + (result?.status_message || 'Unknown error'), 'error');
          console.error('Snap error:', result);
        },
        onClose: function () { /* user closed popup without paying */ },
      });
    } catch (err) {
      console.error(err);
      showAlert('Error: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Bayar via Midtrans';
    }
  });

  boot();
})();
