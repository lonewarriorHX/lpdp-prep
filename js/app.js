// Shared app utilities: auth + data sync (Supabase-backed, localStorage fallback)

(function () {
  const USER_KEY = 'lpdp_user';
  const USERS_KEY = 'lpdp_users';

  const App = {
    currentUser: null, // { id, name, email } — populated after initAuth or local login
    isPro: false,      // populated from profiles.is_pro after auth
    isAlumni: false,   // populated from profiles.is_alumni
    alumniStatus: 'none',
    alumniPromoCode: null,
    alumniUniversity: null,
    alumniYear: null,
    alumniNotes: null,

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
          console.warn('[SIAP Studi] Auth init failed:', err);
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
      App.isAlumni = false;
      App.alumniStatus = 'none';
      App.alumniPromoCode = null;
      App.alumniUniversity = null;
      App.alumniYear = null;
      App.alumniNotes = null;
      if (!window.sb || !App.currentUser) return;
      try {
        const { data } = await window.sb
          .from('profiles')
          .select('is_pro, pro_expires_at, is_alumni, alumni_status, alumni_promo_code, alumni_university, alumni_year, alumni_notes')
          .eq('id', App.currentUser.id)
          .maybeSingle();
        const flagged = !!data?.is_pro;
        const notExpired = !data?.pro_expires_at ||
                           new Date(data.pro_expires_at) > new Date();
        App.isPro = flagged && notExpired;
        App.isAlumni = !!data?.is_alumni;
        App.alumniStatus = data?.alumni_status || 'none';
        App.alumniPromoCode = data?.alumni_promo_code || null;
        App.alumniUniversity = data?.alumni_university || null;
        App.alumniYear = data?.alumni_year || null;
        App.alumniNotes = data?.alumni_notes || null;
      } catch (err) {
        console.warn('[SIAP Studi] Profile status check failed:', err);
      }
    },

    async submitAlumniRequest({ university, year, notes }) {
      if (!window.sb || !App.currentUser) {
        return { ok: false, error: 'Anda harus login terlebih dahulu.' };
      }
      try {
        const { error } = await window.sb
          .from('profiles')
          .update({
            alumni_status: 'pending',
            alumni_university: university || null,
            alumni_year: year || null,
            alumni_notes: notes || null,
          })
          .eq('id', App.currentUser.id);
        if (error) return { ok: false, error: error.message };
        await App._refreshProStatus();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || 'Gagal mengirim permintaan.' };
      }
    },

    _setUserFromSession(session) {
      if (!session || !session.user) {
        App.currentUser = null;
        App.isPro = false;
        App.isAlumni = false;
        App.alumniStatus = 'none';
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
    getIsAlumni() { return App.isAlumni; },
    getAlumniStatus() { return App.alumniStatus; },
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
        const firstName = (user.name || '').split(' ')[0] || 'Akun';
        link.textContent = 'Akun (' + firstName + ')';
        link.href = 'account.html';
        link.onclick = null;
      } else {
        link.textContent = 'Masuk';
        link.href = 'login.html';
        link.onclick = null;
      }
    },

    // ---------------- USAGE LIMITS ----------------
    // Atomically checks the daily cap for the action and records one use if allowed.
    // Returns { ok, allowed, used, limit, remaining, isPro, error? }
    async checkAndRecordUsage(action) {
      if (!window.sb || !App.currentUser) {
        return { ok: false, allowed: false, error: 'not_logged_in' };
      }
      try {
        const { data, error } = await window.sb.rpc('check_and_record_usage', { p_action: action });
        if (error) {
          console.warn('[SIAP Studi] checkAndRecordUsage error:', error);
          return { ok: false, allowed: false, error: error.message };
        }
        return {
          ok: true,
          allowed:   !!data.allowed,
          used:      data.used ?? 0,
          limit:     data.limit ?? 0,
          remaining: data.remaining ?? 0,
          isPro:     !!data.is_pro,
        };
      } catch (err) {
        console.warn('[SIAP Studi] checkAndRecordUsage threw:', err);
        return { ok: false, allowed: false, error: String(err) };
      }
    },

    async getTodayUsage(action) {
      if (!window.sb || !App.currentUser) return 0;
      try {
        const { data, error } = await window.sb.rpc('get_today_usage', { p_action: action });
        if (error) return 0;
        return data ?? 0;
      } catch { return 0; }
    },

    // ---------------- ESSAY ----------------
    saveEssay(text) { localStorage.setItem('lpdp_essay', text); }, // local draft cache
    getEssay() { return localStorage.getItem('lpdp_essay') || ''; },

    async saveEssayToDb(content, meta, analysis) {
      if (!window.sb || !App.currentUser) return { ok: false, skipped: true };

      // Build a clean snapshot — strip transient/loading flags before persisting
      const snapshot = analysis ? {
        overall: analysis.overall,
        structure: analysis.structure,
        clarity: analysis.clarity,
        impact: analysis.impact,
        coverageAvg: analysis.coverageAvg,
        coveredCount: analysis.coveredCount,
        wordN: analysis.wordN,
        sentences: analysis.sentences,
        paragraphs: analysis.paragraphs,
        coverage: analysis.coverage,
        strengths: analysis.strengths,
        weaknesses: analysis.weaknesses,
        suggestions: analysis.suggestions,
        paraAnalysis: analysis.paraAnalysis,
        similarity: analysis.similarity,                  // includes topMatches list + scores
        awardeeFeedback: analysis.awardeeFeedback,         // AI per-aspect comparative feedback
        awardeeFeedbackIsPro: analysis.awardeeFeedbackIsPro,
        awardeeFeedbackError: analysis.awardeeFeedbackError,
        context: analysis.context,
      } : null;

      const { error } = await window.sb.from('essays').insert({
        user_id: App.currentUser.id,
        content,
        overall_score: analysis?.overall ?? null,
        analysis: snapshot,
        degree_level: meta?.degreeLevel ?? null,
        university_location: meta?.universityLocation ?? null,
        university_id: meta?.universityId ?? null,
        university_name: meta?.universityName ?? null,
        coverage: analysis?.coverage ?? null,
        language: meta?.language ?? null,
      });
      if (error) { console.warn('[SIAP Studi] saveEssayToDb error:', error); return { ok: false, error }; }
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
      if (error) { console.warn('[SIAP Studi] fetchReferenceEssays error:', error); return []; }
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
      if (error) { console.warn('[SIAP Studi] fetchReferenceQuestions error:', error); return []; }
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
        console.warn('[SIAP Studi] getAwardeeFeedback error:', err);
        return { ok: false, error: String(err) };
      }
    },

    // Calls the `interview-questions` Edge Function. Returns:
    //   { ok: true, questions: [{q, focus}] }
    //   { ok: false, error: '...' }
    async generateInterviewQuestions({ essay, n, language }) {
      if (!window.sb) return { ok: false, error: 'Supabase belum terkonfigurasi.' };
      const references = await App.fetchReferenceQuestions(language).catch(() => []);
      try {
        const { data, error } = await window.sb.functions.invoke('interview-questions', {
          body: {
            essay,
            n,
            language: language || 'id',
            references: (references || []).map(r => ({
              question: r.question, focus: r.focus, notes: r.notes,
            })),
          },
        });
        if (error) return { ok: false, error: error.message || String(error) };
        if (!data || data.ok === false) {
          return { ok: false, error: data?.error || 'Gagal membuat pertanyaan.' };
        }
        return { ok: true, questions: data.questions || [], refCount: references.length };
      } catch (err) {
        console.warn('[SIAP Studi] generateInterviewQuestions error:', err);
        return { ok: false, error: String(err) };
      }
    },

    // Calls the `interview-evaluate` Edge Function. Returns:
    //   { ok: true, evaluation: {...} } | { ok: false, error: '...' }
    async evaluateInterview({ essay, language, qa }) {
      if (!window.sb) return { ok: false, error: 'Supabase belum terkonfigurasi.' };
      if (!Array.isArray(qa) || !qa.length) return { ok: false, error: 'Tidak ada Q&A untuk dievaluasi.' };
      try {
        const { data, error } = await window.sb.functions.invoke('interview-evaluate', {
          body: { essay: essay || '', language: language || 'id', qa },
        });
        if (error) return { ok: false, error: error.message || String(error) };
        if (!data || data.ok === false) {
          return { ok: false, error: data?.error || 'Gagal evaluasi.' };
        }
        return { ok: true, evaluation: data.evaluation };
      } catch (err) {
        console.warn('[SIAP Studi] evaluateInterview error:', err);
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
      if (error) { console.warn('[SIAP Studi] fetchUniversities error:', error); return []; }
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
      if (error) { console.warn('[SIAP Studi] fetchTbsQuestions error:', error); return []; }
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
      if (error) console.warn('[SIAP Studi] saveTbsSessionToDb error:', error);
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
      if (error) console.warn('[SIAP Studi] saveInterviewSessionToDb error:', error);
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
