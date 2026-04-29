// Auth controller — uses Supabase via App (localStorage fallback when offline)

(function () {
  const el = (id) => document.getElementById(id);

  const tabLogin = el('tabLogin');
  const tabSignup = el('tabSignup');
  const loginForm = el('loginForm');
  const signupForm = el('signupForm');
  const alertBox = el('alertBox');

  function showAlert(msg, type) {
    alertBox.innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
    if (type === 'success') setTimeout(() => alertBox.innerHTML = '', 2000);
  }
  function clearAlert() { alertBox.innerHTML = ''; }

  function switchTo(mode) {
    clearAlert();
    if (mode === 'signup') {
      tabSignup.classList.add('active');
      tabLogin.classList.remove('active');
      signupForm.classList.remove('hidden');
      loginForm.classList.add('hidden');
    } else {
      tabLogin.classList.add('active');
      tabSignup.classList.remove('active');
      loginForm.classList.remove('hidden');
      signupForm.classList.add('hidden');
    }
  }

  tabLogin.addEventListener('click', () => switchTo('login'));
  tabSignup.addEventListener('click', () => switchTo('signup'));

  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'signup') switchTo('signup');

  function setLoading(btn, loading, labelDefault) {
    btn.disabled = loading;
    btn.textContent = loading ? 'Memproses...' : labelDefault;
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = loginForm.querySelector('button[type=submit]');
    const email = el('loginEmail').value.trim();
    const pass = el('loginPass').value;
    setLoading(btn, true, 'Masuk');
    const res = await App.login(email, pass);
    setLoading(btn, false, 'Masuk');
    if (!res.ok) return showAlert(res.error || 'Gagal masuk.', 'error');
    showAlert('Berhasil masuk. Mengalihkan...', 'success');
    setTimeout(() => window.location.href = 'index.html', 700);
  });

  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = signupForm.querySelector('button[type=submit]');
    const name = el('signupName').value.trim();
    const email = el('signupEmail').value.trim();
    const pass = el('signupPass').value;
    if (pass.length < 6) return showAlert('Password minimal 6 karakter.', 'error');
    setLoading(btn, true, 'Daftar');
    const res = await App.signup(name, email, pass);
    setLoading(btn, false, 'Daftar');
    if (!res.ok) return showAlert(res.error || 'Gagal mendaftar.', 'error');
    if (res.needsConfirm) {
      showAlert('Akun dibuat. Cek email-mu untuk konfirmasi, lalu masuk.', 'success');
      switchTo('login');
      el('loginEmail').value = email;
      return;
    }
    showAlert('Akun dibuat. Mengalihkan...', 'success');
    setTimeout(() => window.location.href = 'index.html', 700);
  });

  // Show a hint if Supabase isn't configured yet
  setTimeout(() => {
    if (!App.isAuthEnabled()) {
      showAlert('Supabase belum dikonfigurasi — menggunakan mode offline (localStorage). Edit <code>js/supabase-config.js</code> untuk mengaktifkan.', 'error');
    } else if (App.getUser()) {
      showAlert('Kamu sudah masuk sebagai ' + App.getUser().name + '. <a href="index.html">Ke beranda</a>', 'success');
    }
  }, 300);
})();
