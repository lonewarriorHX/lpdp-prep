window.SUPABASE_CONFIG = {
  url: '',  // Will be set to the API base URL, e.g. 'http://62.146.235.187' or 'https://siapstudi.com'
  anonKey: 'not-used'  // Kept for backward compat with pricing.js
};

// Auto-detect API URL: same origin as the page
(function() {
  if (!window.SUPABASE_CONFIG.url) {
    window.SUPABASE_CONFIG.url = window.location.origin;
  }
})();
