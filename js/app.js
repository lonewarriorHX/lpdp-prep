// Shared app utilities: auth + data sync (Supabase-backed, localStorage fallback)

(function () {
  const USER_KEY = 'lpdp_user';
  const USERS_KEY = 'lpdp_users';

  const App = {
    currentUser: null, // { id, name, email } — populated after initAuth or local login
    isPro: false,      // populated from profiles.is_pro after auth

    // ---------------- AUTH ----------------
    async initAuth() {
      if (window.sb) {
        try {
          const { data: { session } } = await window.sb.auth.getSession();
          App._setUserFromSession(session);
          await App._refreshProStatus();
          window.sb.auth.onAuthStateChange(async (_event, newSession) => {
            App._setUserFromSession(newSession);
            await App._refreshProStatus();
            App.updateAuthLink();
          });
        } catch (err) {
          console.warn('[LPDP Prep] Auth init failed:', err);
        }
      } else {
        // Offline fallback — load from localStorage
        try {
          const u = JSON.parse(localStorage.getItem(USER_KEY));
          if (u) App.currentUser = u;
        } catch {}
      }
      App.updateAuthLink();
    },

    async _refreshProStatus() {
      App.isPro = false;
      if (!window.sb || !App.currentUser) return;
      try {
        const { data } = await window.sb
          .from('profiles')
          .select('is_pro, pro_expires_at')
          .eq('id', App.currentUser.id)
          .maybeSingle();
        const flagged = !!data?.is_pro;
        const notExpired = !data?.pro_expires_at ||
                           new Date(data.pro_expires_at) > new Date();
        App.isPro = flagged && notExpired;
      } catch (err) {
        console.warn('[LPDP Prep] Pro status check failed:', err);
      }
    },

    _setUserFromSession(session) {
      if (!session || !session.user) {
        App.currentUser = null;
        App.isPro = false;
        return;
      }
      const u = session.user;
      App.currentUser = {
        id: u.id,
        email: u.email,
        name: u.user_metadata?.name || u.email?.split('@')[0] || 'User',
      };
    },

    getUser() { return App.currentUser; },
    getIsPro() { return App.isPro; },
    isAuthEnabled() { return !!window.sb; },

    async signup(name, email, password) {
      if (window.sb) {
        const { data, error } = await window.sb.auth.signUp({
          email, password,
          options: { data: { name } },
        });
        if (error) return { ok: false, error: error.message };
        if (!data.session) {
          return { ok: true, needsConfirm: true };
        }
        App._setUserFromSession(data.session);
        return { ok: true };
      }
      // Offline fallback
      const users = App._getLocalUsers();
      if (users.find(u => u.email === email)) return { ok: false, error: 'Email sudah terdaftar.' };
      users.push({ name, email, password, createdAt: Date.now() });
      localStorage.setItem(USERS_KEY, JSON.stringify(users));
      App.currentUser = { name, email, id: 'local-' + email };
      localStorage.setItem(USER_KEY, JSON.stringify(App.currentUser));
      return { ok: true };
    },

    async login(email, password) {
      if (window.sb) {
        const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
        if (error) return { ok: false, error: error.message };
        App._setUserFromSession(data.session);
        return { ok: true };
      }
      // Offline fallback
      const users = App._getLocalUsers();
      const user = users.find(u => u.email === email && u.password === password);
      if (!user) return { ok: false, error: 'Email atau password salah.' };
      App.currentUser = { name: user.name, email: user.email, id: 'local-' + user.email };
      localStorage.setItem(USER_KEY, JSON.stringify(App.currentUser));
      return { ok: true };
    },

    async logout() {
      if (window.sb) {
        try { await window.sb.auth.signOut(); } catch {}
      }
      App.currentUser = null;
      localStorage.removeItem(USER_KEY);
      window.location.href = 'index.html';
    },

    _getLocalUsers() {
      try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; } catch { return []; }
    },

    updateAuthLink() {
      const link = document.getElementById('authLink');
      if (!link) return;
      const user = App.currentUser;
      if (user) {
        link.textContent = 'Keluar (' + (user.name || '').split(' ')[0] + ')';
        link.href = '#';
        link.onclick = function (e) { e.preventDefault(); App.logout(); };
      } else {
        link.textContent = 'Masuk';
        link.href = 'login.html';
        link.onclick = null;
      }
    },

    // ---------------- ESSAY ----------------
    saveEssay(text) { localStorage.setItem('lpdp_essay', text); }, // local draft cache
    getEssay() { return localStorage.getItem('lpdp_essay') || ''; },

    async saveEssayToDb(content, meta, analysis) {
      if (!window.sb || !App.currentUser) return { ok: false, skipped: true };
      const { error } = await window.sb.from('essays').insert({
        user_id: App.currentUser.id,
        content,
        overall_score: analysis?.overall ?? null,
        analysis,
        degree_level: meta?.degreeLevel ?? null,
        university_location: meta?.universityLocation ?? null,
        university_id: meta?.universityId ?? null,
        university_name: meta?.universityName ?? null,
        coverage: analysis?.coverage ?? null,
        language: meta?.language ?? null,
      });
      if (error) { console.warn('[LPDP Prep] saveEssayToDb error:', error); return { ok: false, error }; }
      return { ok: true };
    },

    async fetchReferenceEssays(language) {
      if (!window.sb) return [];
      let q = window.sb
        .from('reference_essays')
        .select('id, user_id, title, author, content, language, degree_level, university_location, university_name, tags, created_at')
        .order('created_at', { ascending: false });
      if (language) q = q.eq('language', language);
      const { data, error } = await q;
      if (error) { console.warn('[LPDP Prep] fetchReferenceEssays error:', error); return []; }
      return data || [];
    },

    async saveReferenceEssay(meta) {
      if (!window.sb || !App.currentUser) return { ok: false, error: { message: 'Harus login.' } };
      const { error } = await window.sb.from('reference_essays').insert({
        user_id: App.currentUser.id,
        title: meta.title,
        author: meta.author ?? null,
        content: meta.content,
        language: meta.language || 'id',
        degree_level: meta.degreeLevel ?? null,
        university_location: meta.universityLocation ?? null,
        university_name: meta.universityName ?? null,
        tags: meta.tags ?? null,
      });
      if (error) return { ok: false, error };
      return { ok: true };
    },

    async deleteReferenceEssay(id) {
      if (!window.sb || !App.currentUser) return { ok: false };
      const { error } = await window.sb.from('reference_essays').delete().eq('id', id);
      return { ok: !error, error };
    },

    // ---------------- REFERENCE QUESTIONS (AI seed material) ----------------
    async fetchReferenceQuestions(language) {
      if (!window.sb) return [];
      let q = window.sb
        .from('reference_questions')
        .select('id, user_id, question, focus, language, notes, tags, created_at')
        .order('created_at', { ascending: false });
      if (language) q = q.eq('language', language);
      const { data, error } = await q;
      if (error) { console.warn('[LPDP Prep] fetchReferenceQuestions error:', error); return []; }
      return data || [];
    },

    async saveReferenceQuestion(meta) {
      if (!window.sb || !App.currentUser) return { ok: false, error: { message: 'Harus login.' } };
      const { error } = await window.sb.from('reference_questions').insert({
        user_id: App.currentUser.id,
        question: meta.question,
        focus: meta.focus ?? null,
        language: meta.language || 'id',
        notes: meta.notes ?? null,
        tags: meta.tags ?? null,
      });
      if (error) return { ok: false, error };
      return { ok: true };
    },

    async deleteReferenceQuestion(id) {
      if (!window.sb || !App.currentUser) return { ok: false };
      const { error } = await window.sb.from('reference_questions').delete().eq('id', id);
      return { ok: !error, error };
    },

    // Calls the `essay-feedback` Edge Function to get LLM-generated comparative
    // feedback (user essay vs top awardee matches). Returns:
    //   { ok: true, feedback: {motivasi, kontribusi, rencana_studi, overall_summary} }
    //   { ok: false, error: '...' }
    async getAwardeeFeedback({ userEssay, language, topMatchIds }) {
      if (!window.sb) return { ok: false, error: 'Supabase belum terkonfigurasi.' };
      if (!Array.isArray(topMatchIds) || !topMatchIds.length) {
        return { ok: false, error: 'Tidak ada referensi awardee untuk dibandingkan.' };
      }
      // Pull full content for the top matches so the LLM has material to cite from
      const { data: refs, error: refErr } = await window.sb
        .from('reference_essays')
        .select('id, title, author, university_name, content')
        .in('id', topMatchIds);
      if (refErr || !refs || !refs.length) {
        return { ok: false, error: 'Gagal memuat referensi awardee.' };
      }
      const awardeeReferences = refs.map(r => ({
        title: r.title || '',
        author: r.author || '',
        university: r.university_name || '',
        excerpt: (r.content || '').slice(0, 2500),
      }));
      try {
        const { data, error } = await window.sb.functions.invoke('essay-feedback', {
          body: { userEssay, language: language || 'id', awardeeReferences },
        });
        if (error) return { ok: false, error: error.message || String(error) };
        if (!data || data.ok === false) {
          return { ok: false, error: data?.error || 'Gagal mendapatkan feedback.' };
        }
        return { ok: true, feedback: data.feedback, isPro: !!data.isPro };
      } catch (err) {
        console.warn('[LPDP Prep] getAwardeeFeedback error:', err);
        return { ok: false, error: String(err) };
      }
    },

    async fetchUniversities(location) {
      if (!window.sb) return App._fallbackUniversities(location);
      const { data, error } = await window.sb
        .from('universities')
        .select('id, name, short_name, country')
        .eq('location', location)
        .order('name', { ascending: true });
      if (error) { console.warn('[LPDP Prep] fetchUniversities error:', error); return []; }
      return data || [];
    },

    _fallbackUniversities(location) {
      const fallback = {
        indonesia: [
          { id: null, name: 'Universitas Indonesia', short_name: 'UI', country: 'Indonesia' },
          { id: null, name: 'Institut Teknologi Bandung', short_name: 'ITB', country: 'Indonesia' },
          { id: null, name: 'Universitas Gadjah Mada', short_name: 'UGM', country: 'Indonesia' },
          { id: null, name: 'IPB University', short_name: 'IPB', country: 'Indonesia' },
        ],
        luar_negeri: [
          { id: null, name: 'Massachusetts Institute of Technology', short_name: 'MIT', country: 'USA' },
          { id: null, name: 'Harvard University', short_name: 'Harvard', country: 'USA' },
          { id: null, name: 'University of Oxford', short_name: 'Oxford', country: 'UK' },
          { id: null, name: 'Delft University of Technology', short_name: 'TU Delft', country: 'Netherlands' },
          { id: null, name: 'National University of Singapore', short_name: 'NUS', country: 'Singapore' },
        ],
      };
      return fallback[location] || [];
    },

    async fetchEssayHistory(limit = 50) {
      if (!window.sb || !App.currentUser) return [];
      const { data, error } = await window.sb
        .from('essays')
        .select('id, essay_type, overall_score, analysis, content, created_at, degree_level, university_location, university_name, coverage, language')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) { console.warn(error); return []; }
      return data || [];
    },

    async fetchTbsHistory(limit = 50) {
      if (!window.sb || !App.currentUser) return [];
      const { data, error } = await window.sb
        .from('tbs_sessions')
        .select('id, category, total_questions, correct, percent, duration_seconds, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) { console.warn(error); return []; }
      return data || [];
    },

    async fetchInterviewHistory(limit = 50) {
      if (!window.sb || !App.currentUser) return [];
      const { data, error } = await window.sb
        .from('interview_sessions')
        .select('id, overall_score, essay_excerpt, questions, answers, evaluation, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) { console.warn(error); return []; }
      return data || [];
    },

    async deleteEssay(id) {
      if (!window.sb || !App.currentUser) return { ok: false };
      const { error } = await window.sb.from('essays').delete().eq('id', id);
      return { ok: !error, error };
    },

    // ---------------- TBS ----------------
    getTbsStats() {
      try { return JSON.parse(localStorage.getItem('lpdp_tbs_stats')) || { sessions: [] }; }
      catch { return { sessions: [] }; }
    },
    saveTbsStats(stats) { localStorage.setItem('lpdp_tbs_stats', JSON.stringify(stats)); },

    // Fetch TBS question pool from Supabase. Returns [] when Supabase isn't
    // configured — caller should fall back to the local TBS_BANK.
    async fetchTbsQuestions(category) {
      if (!window.sb) return [];
      let q = window.sb
        .from('tbs_questions')
        .select('id, category, subcategory, question, options, answer_index, explanation');
      if (category && category !== 'campuran') q = q.eq('category', category);
      const { data, error } = await q;
      if (error) { console.warn('[LPDP Prep] fetchTbsQuestions error:', error); return []; }
      return (data || []).map(r => ({
        q: r.question,
        opts: r.options,
        a: r.answer_index,
        exp: r.explanation || '',
        _cat: r.category,
        _sub: r.subcategory,
        _id: r.id,
      }));
    },

    async saveTbsQuestion(meta) {
      if (!window.sb || !App.currentUser) return { ok: false, error: { message: 'Harus login.' } };
      const { error } = await window.sb.from('tbs_questions').insert({
        user_id: App.currentUser.id,
        category: meta.category,
        subcategory: meta.subcategory ?? null,
        question: meta.question,
        options: meta.options,
        answer_index: meta.answerIndex,
        explanation: meta.explanation ?? null,
      });
      if (error) return { ok: false, error };
      return { ok: true };
    },

    async deleteTbsQuestion(id) {
      if (!window.sb || !App.currentUser) return { ok: false };
      const { error } = await window.sb.from('tbs_questions').delete().eq('id', id);
      return { ok: !error, error };
    },

    async saveTbsSessionToDb(session) {
      if (!window.sb || !App.currentUser) return { ok: false, skipped: true };
      const { error } = await window.sb.from('tbs_sessions').insert({
        user_id: App.currentUser.id,
        category: session.category,
        total_questions: session.total,
        correct: session.correct,
        percent: session.percent,
        duration_seconds: session.duration ?? null,
      });
      if (error) console.warn('[LPDP Prep] saveTbsSessionToDb error:', error);
      return { ok: !error };
    },

    // ---------------- INTERVIEW ----------------
    async saveInterviewSessionToDb(session) {
      if (!window.sb || !App.currentUser) return { ok: false, skipped: true };
      const { error } = await window.sb.from('interview_sessions').insert({
        user_id: App.currentUser.id,
        essay_excerpt: session.essayExcerpt,
        questions: session.questions,
        answers: session.answers,
        overall_score: session.overall,
        evaluation: session.evaluation,
      });
      if (error) console.warn('[LPDP Prep] saveInterviewSessionToDb error:', error);
      return { ok: !error };
    },
  };

  // Init on DOM ready
  document.addEventListener('DOMContentLoaded', function () {
    App.initAuth();
    const toggle = document.getElementById('navToggle');
    const links = document.getElementById('navLinks');
    if (toggle && links) toggle.addEventListener('click', () => links.classList.toggle('open'));
  });

  window.App = App;
})();
