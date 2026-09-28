(function() {
  const TOKEN_KEY = 'siapstudi_token';
  const USER_KEY = 'siapstudi_user';

  class ApiClient {
    constructor(baseUrl) {
      this.baseUrl = baseUrl;
      this.auth = new AuthClient(this);
      this.functions = { invoke: (name, opts) => this._invokeFn(name, opts) };
    }

    _getToken() { return localStorage.getItem(TOKEN_KEY); }
    _setToken(token) { localStorage.setItem(TOKEN_KEY, token); }
    _getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
    _setUser(user) { localStorage.setItem(USER_KEY, JSON.stringify(user)); }
    _clearAuth() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }

    _headers() {
      const h = { 'Content-Type': 'application/json' };
      const t = this._getToken();
      if (t) h['Authorization'] = 'Bearer ' + t;
      return h;
    }

    from(table) { return new QueryBuilder(this, table); }

    async rpc(name, params) {
      try {
        const res = await fetch(this.baseUrl + '/api/rpc/' + name, {
          method: 'POST', headers: this._headers(), body: JSON.stringify(params || {})
        });
        const json = await res.json();
        if (!res.ok) return { data: null, error: json };
        return { data: json.data !== undefined ? json.data : json, error: null };
      } catch(e) { return { data: null, error: { message: e.message } }; }
    }

    async _invokeFn(name, opts) {
      try {
        const res = await fetch(this.baseUrl + '/api/fn/' + name, {
          method: 'POST', headers: this._headers(), body: JSON.stringify(opts?.body || {})
        });
        const json = await res.json();
        if (!res.ok) return { data: null, error: json };
        return { data: json, error: null };
      } catch(e) { return { data: null, error: { message: e.message } }; }
    }
  }

  class AuthClient {
    constructor(client) { this.client = client; this._listeners = []; }

    async signUp({ email, password, options }) {
      const name = options?.data?.name || '';
      const res = await fetch(this.client.baseUrl + '/api/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name })
      });
      const json = await res.json();
      if (!res.ok || json.error) return { data: { session: null, user: null }, error: json.error || json };
      this.client._setToken(json.data.session.access_token);
      this.client._setUser(json.data.user || json.data.session.user);
      this._notify('SIGNED_IN', json.data.session);
      return { data: json.data, error: null };
    }

    async signInWithPassword({ email, password }) {
      const res = await fetch(this.client.baseUrl + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const json = await res.json();
      if (!res.ok || json.error) return { data: { session: null, user: null }, error: json.error || json };
      this.client._setToken(json.data.session.access_token);
      this.client._setUser(json.data.user || json.data.session.user);
      this._notify('SIGNED_IN', json.data.session);
      return { data: json.data, error: null };
    }

    async getSession() {
      const token = this.client._getToken();
      const user = this.client._getUser();
      if (!token || !user) return { data: { session: null } };
      return { data: { session: { access_token: token, user: user } } };
    }

    async getUser() {
      const token = this.client._getToken();
      if (!token) return { data: { user: null } };
      const user = this.client._getUser();
      return { data: { user: user } };
    }

    async signOut() {
      this.client._clearAuth();
      this._notify('SIGNED_OUT', null);
      return { error: null };
    }

    onAuthStateChange(callback) {
      this._listeners.push(callback);
      return { data: { subscription: { unsubscribe: () => {
        this._listeners = this._listeners.filter(l => l !== callback);
      }}}};
    }

    _notify(event, session) {
      this._listeners.forEach(cb => { try { cb(event, session); } catch(e) { console.warn(e); } });
    }
  }

  class QueryBuilder {
    constructor(client, table) {
      this._client = client;
      this._table = table;
      this._method = 'GET';
      this._body = null;
      this._params = {};
      this._isSingle = false;
    }

    select(cols) { this._params.select = cols || '*'; this._method = 'GET'; return this; }
    insert(data) { this._body = data; this._method = 'POST'; return this; }
    update(data) { this._body = data; this._method = 'PATCH'; return this; }
    delete() { this._method = 'DELETE'; return this; }
    eq(col, val) { this._params['eq.' + col] = val; return this; }
    in(col, vals) { this._params['in.' + col] = Array.isArray(vals) ? vals.join(',') : vals; return this; }
    order(col, opts) { this._params.order = col + '.' + (opts && opts.ascending === true ? 'asc' : 'desc'); return this; }
    limit(n) { this._params.limit = String(n); return this; }
    maybeSingle() { this._isSingle = true; return this; }

    then(resolve, reject) { return this._execute().then(resolve, reject); }
    catch(fn) { return this._execute().catch(fn); }

    async _execute() {
      const url = new URL(this._client.baseUrl + '/api/data/' + this._table);
      Object.entries(this._params).forEach(function(entry) { url.searchParams.set(entry[0], entry[1]); });
      if (this._isSingle) url.searchParams.set('single', '1');

      const opts = { method: this._method, headers: this._client._headers() };
      if (this._body) { opts.body = JSON.stringify(this._body); }

      try {
        const res = await fetch(url.toString(), opts);
        const json = await res.json();
        if (!res.ok) return { data: null, error: json.error || json };
        return { data: json.data !== undefined ? json.data : json, error: null };
      } catch(e) {
        return { data: null, error: { message: e.message } };
      }
    }
  }

  // Initialize
  const cfg = window.SUPABASE_CONFIG || {};
  const baseUrl = (cfg.url || window.location.origin).replace(/\/+$/, '');
  window.sb = new ApiClient(baseUrl);
})();
