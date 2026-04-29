// Supabase client initializer
// Loads after the supabase-js UMD bundle and before app.js

(function () {
  const cfg = window.SUPABASE_CONFIG || {};
  const isPlaceholder = !cfg.url || cfg.url.includes('YOUR_PROJECT') || !cfg.anonKey || cfg.anonKey.includes('YOUR_ANON');

  if (isPlaceholder || typeof window.supabase === 'undefined') {
    if (isPlaceholder) {
      console.warn('[LPDP Prep] Supabase not configured — running in offline mode. Fill in js/supabase-config.js to enable auth + database.');
    }
    window.sb = null;
    return;
  }

  try {
    window.sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  } catch (err) {
    console.error('[LPDP Prep] Failed to initialize Supabase:', err);
    window.sb = null;
  }
})();
