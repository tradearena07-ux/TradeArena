// TradeArena — shared client logic (Supabase-backed).
//
// Public API (window.TArenaAuth):
//   --- async ---
//   startSignup(email, type)              -> { ok, error?, email? }
//   verifySignupOtp(code)                 -> { ok, error?, email?, type? }
//   completeSignup(username, password)    -> { ok, error? }
//   login(identifier, password)           -> { ok, error? }
//   startReset(identifier)                -> { ok, error?, email? }
//   verifyResetOtp(code)                  -> { ok, error?, email? }
//   completeReset(newPassword)            -> { ok, error? }
//   signOut()                             -> Promise<void>
//   saveProfile(updates)                  -> { ok, error? }
//   reloadSession()                       -> Promise<session|null>
//   isUsernameAvailable(username)         -> Promise<boolean>
//   getRegistrations()                    -> Promise<Array>   (admin only)
//
//   --- sync (read from in-memory cache primed at module load) ---
//   getSession()                          -> { user } | null
//   requireAuth()                         -> session | null  (redirects to auth.html if no session)
//   getProfile([email])                   -> profile (current user only)
//   suggestUsername(email)                -> string
//   isStudentEmail(email)                 -> boolean
//   getUniversity(email)                  -> string
//   onAuthChange(fn)                      -> unsubscribe function
//
// window.TArenaUI:  renderNav, renderFooter, fmtMoney, fmtPct, getAvatar, avatarHtml
//
(function (global) {

  // ============================================================
  // Config + client
  // ============================================================
  const sb = global.TArenaDB;
  if (!sb) {
    console.error('[TradeArena] window.TArenaDB missing — load assets/supabase.js before app.js.');
  }

  const PENDING_KEY       = 'tarena_pending_email';
  const PROFILE_CACHE_KEY = 'tarena_profile_cache';

  // ============================================================
  // Helpers (sync, no Supabase)
  // ============================================================
  function isStudentEmail(email) {
    // Per task contract: only emails ending in `.edu.au` get Student tier.
    // Anything else (including `.ac.nz` or `monash.edu`) falls through to
    // Member tier even if the user toggled "Student" at signup.
    const lower = (email || '').toLowerCase();
    return lower.endsWith('.edu.au');
  }

  function getUniversity(email) {
    const d = ((email || '').split('@')[1] || '').toLowerCase();
    const map = {
      'student.unsw.edu.au':    'UNSW Sydney',
      'unsw.edu.au':            'UNSW Sydney',
      'ad.unsw.edu.au':         'UNSW Sydney',
      'usyd.edu.au':            'University of Sydney',
      'student.usyd.edu.au':    'University of Sydney',
      'uts.edu.au':             'UTS Sydney',
      'student.uts.edu.au':     'UTS Sydney',
      'mq.edu.au':              'Macquarie University',
      'students.mq.edu.au':     'Macquarie University',
      'unimelb.edu.au':         'University of Melbourne',
      'student.unimelb.edu.au': 'University of Melbourne',
      'monash.edu':             'Monash University',
      'student.monash.edu':     'Monash University',
      'anu.edu.au':             'ANU',
      'uq.edu.au':              'University of Queensland',
      'qut.edu.au':             'QUT',
      'curtin.edu.au':          'Curtin University',
      'uwa.edu.au':             'University of WA',
      'adelaide.edu.au':        'University of Adelaide',
      'rmit.edu.au':            'RMIT University',
      'deakin.edu.au':          'Deakin University',
    };
    if (map[d]) return map[d];
    if (d.endsWith('.edu.au')) return d.replace(/\.edu\.au$/, '').toUpperCase();
    return 'Public';
  }

  function suggestUsername(email) {
    const local = (email || '').split('@')[0] || '';
    return local.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'trader' + Math.floor(Math.random() * 9999);
  }

  function _validUsername(u) {
    return typeof u === 'string' && /^[a-z][a-z0-9_]{2,19}$/.test(u);
  }

  // ============================================================
  // Pending-state helpers (for the multi-step signup / reset flows)
  // ============================================================
  function _pending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch (_) { return null; }
  }
  function _setPending(p) { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); }
  function _clearPending() { localStorage.removeItem(PENDING_KEY); }

  // ============================================================
  // Session cache (sync), primed at module load from localStorage
  // ============================================================
  let _sessionCache = null;
  const _authChangeListeners = new Set();

  function _toUser(authUser, profile) {
    profile = profile || {};
    const meta = (authUser && authUser.user_metadata) || {};
    const email = (authUser && authUser.email) || '';
    const username = profile.username || meta.username || (email.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'trader';
    const university = profile.university || meta.university || getUniversity(email);
    const type = profile.type || meta.type || (isStudentEmail(email) ? 'student' : 'public');
    return {
      id:           authUser.id,
      email:        email,
      username:     username,
      handle:       '@' + username,
      university:   university,
      type:         type,
      displayName:  profile.display_name || username,
      bio:          profile.bio || '',
      tier:         profile.tier || (type === 'student' ? 'Student' : 'Member'),
      avatarColor:  profile.avatar_color || null,
      avatarUrl:    profile.avatar_url || null,
      isAdmin:      !!profile.is_admin,
      visibilityMask: profile.visibility_mask || {},
      joinedAt:     authUser.created_at ? new Date(authUser.created_at).getTime() : Date.now(),
      profileExists: !!profile.id,
    };
  }

  function _readProfileCache(email) {
    try {
      const c = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || '{}');
      return c[email] || null;
    } catch (_) { return null; }
  }
  function _writeProfileCache(email, profile) {
    try {
      const c = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || '{}');
      if (profile) c[email] = profile; else delete c[email];
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(c));
    } catch (_) {}
  }

  // Sync prime: read Supabase's cached session straight from localStorage
  // so getSession()/requireAuth() work on first paint without awaiting.
  function _primeSyncFromStorage() {
    try {
      const raw = localStorage.getItem('tarena_sb_session');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // Supabase stores either { currentSession, expiresAt } or the session directly.
      const session = parsed.currentSession || parsed;
      if (!session || !session.user) return;
      const profile = _readProfileCache(session.user.email);
      _sessionCache = _toUser(session.user, profile || {});
    } catch (_) {}
  }

  function _notifyAuthChange() {
    _authChangeListeners.forEach(fn => { try { fn(_sessionCache ? { user: _sessionCache } : null); } catch (_) {} });
    // Re-render mounted nav so the avatar pill appears/disappears immediately
    if (global.TArenaUI && global.__tarena_nav_active) {
      global.TArenaUI.renderNav(global.__tarena_nav_active);
    }
  }

  async function _hydrateFromServer() {
    if (!sb) return null;
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session || !session.user) {
        _sessionCache = null;
        _writeProfileCache(null);
        _notifyAuthChange();
        return null;
      }
      const { data: profile } = await sb
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();
      _sessionCache = _toUser(session.user, profile || {});
      _writeProfileCache(session.user.email, profile);
      _notifyAuthChange();
      return { user: _sessionCache };
    } catch (e) {
      console.warn('[TradeArena] hydrate failed', e);
      return null;
    }
  }

  // Boot: prime sync, then kick off async hydrate, then subscribe to changes.
  _primeSyncFromStorage();
  if (sb) {
    _hydrateFromServer();
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        _sessionCache = null;
        _writeProfileCache(null);
        _notifyAuthChange();
      } else if (session) {
        _hydrateFromServer();
      }
    });
  }

  // ============================================================
  // Public sync API
  // ============================================================
  function getSession() {
    return _sessionCache ? { user: _sessionCache, createdAt: Date.now() } : null;
  }

  function requireAuth() {
    const s = getSession();
    if (!s) { window.location.href = 'auth.html'; return null; }
    return s;
  }

  function getProfile(email) {
    // Sync — returns the in-memory profile for the current session user.
    // Other users' profiles must be fetched via supabase directly.
    if (!_sessionCache) return null;
    if (email && email !== _sessionCache.email) {
      // For now, return the cached snapshot if we have one.
      const c = _readProfileCache(email);
      return c ? _toUser({ id: '?', email, created_at: new Date().toISOString() }, c) : null;
    }
    return _sessionCache;
  }

  function onAuthChange(fn) {
    _authChangeListeners.add(fn);
    return () => _authChangeListeners.delete(fn);
  }

  async function reloadSession() { return _hydrateFromServer(); }

  // ============================================================
  // Sign-up flow:  email -> OTP -> set password & username
  // ============================================================
  async function startSignup(email, type) {
    email = (email || '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'Please enter your email address.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'That doesn\'t look like a valid email address.' };
    if (type === 'student' && !isStudentEmail(email)) {
      return { ok: false, error: 'Please use a university email (.edu.au) or switch to <strong>Public</strong> above.' };
    }

    // Check if account is already fully set up
    try {
      const { data: avail, error: rpcErr } = await sb.rpc('check_email_available', { p_email: email });
      if (rpcErr) console.warn('check_email_available failed', rpcErr);
      else if (avail === false) {
        return { ok: false, error: 'An account already exists for this email. <a href="#" onclick="window.__switchTab&&window.__switchTab(\'login\');return false;">Log in instead →</a>' };
      }
    } catch (e) { console.warn(e); }

    // Send OTP — Supabase mails the 6-digit code to the user's inbox.
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) return { ok: false, error: _friendly(error) };

    _setPending({ email, type, purpose: 'signup', sentAt: Date.now() });
    return { ok: true, email };
  }

  async function verifySignupOtp(code) {
    const p = _pending();
    if (!p || p.purpose !== 'signup') return { ok: false, error: 'No verification in progress. Start over.' };
    code = String(code || '').trim();
    if (!/^\d{6}$/.test(code)) return { ok: false, error: 'Enter the 6-digit code.' };

    const { data, error } = await sb.auth.verifyOtp({
      email: p.email, token: code, type: 'email',
    });
    if (error) return { ok: false, error: _friendly(error) };

    p.verified = true;
    _setPending(p);
    await _hydrateFromServer();
    return { ok: true, email: p.email, type: p.type };
  }

  async function completeSignup(username, password) {
    const p = _pending();
    if (!p || p.purpose !== 'signup' || !p.verified) {
      return { ok: false, error: 'Email not verified yet.' };
    }
    username = (username || '').trim().toLowerCase();
    if (!_validUsername(username)) {
      return { ok: false, error: 'Username must be 3–20 chars, start with a letter (a–z, 0–9, _).' };
    }
    if (!password || password.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };

    // Username uniqueness check
    const { data: free, error: rpcErr } = await sb.rpc('check_username_available', { p_username: username });
    if (rpcErr) console.warn(rpcErr);
    else if (free === false) return { ok: false, error: 'That username is already taken.' };

    // Set password + metadata on the auth user
    const meta = { username, type: p.type, university: getUniversity(p.email) };
    const { data: { user }, error: upErr } = await sb.auth.updateUser({ password, data: meta });
    if (upErr) return { ok: false, error: _friendly(upErr) };
    if (!user) return { ok: false, error: 'Could not finalise account. Try logging in.' };

    // Insert profile row (RLS allows self-insert).
    // We deliberately do NOT store the email here — auth.users.email is the
    // single source of truth, and duplicating it would create an enumeration
    // surface that the public view would otherwise leak.
    const profileRow = {
      id:           user.id,
      username,
      display_name: username,
      university:   meta.university,
      type:         p.type,
      tier:         p.type === 'student' ? 'Student' : 'Member',
      bio:          '',
    };
    const { error: pErr } = await sb.from('profiles').insert(profileRow);
    if (pErr && !/duplicate/i.test(pErr.message)) {
      return { ok: false, error: _friendly(pErr) };
    }

    _clearPending();
    await _hydrateFromServer();
    return { ok: true };
  }

  async function isUsernameAvailable(username) {
    if (!_validUsername((username || '').toLowerCase())) return false;
    const { data, error } = await sb.rpc('check_username_available', { p_username: username });
    if (error) return false;
    return !!data;
  }

  // ============================================================
  // Login (no OTP)
  // ============================================================
  async function login(identifier, password) {
    if (!identifier || !password) return { ok: false, error: 'Enter your email/username and password.' };

    let email = identifier.trim();
    if (!email.includes('@')) {
      // Username login — resolve email server-side. The RPC verifies the
      // password against the bcrypt hash and returns the email ONLY if the
      // credentials are correct, so it cannot be used to enumerate emails.
      const { data, error } = await sb.rpc('email_for_username_login', {
        p_username: identifier.trim(),
        p_password: password,
      });
      if (error)        return { ok: false, error: _friendly(error) };
      if (!data)        return { ok: false, error: 'Incorrect email/username or password.' };
      email = data;
    }

    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('invalid login')) return { ok: false, error: 'Incorrect email/username or password.' };
      return { ok: false, error: _friendly(error) };
    }
    await _hydrateFromServer();
    return { ok: true };
  }

  // ============================================================
  // Forgot password:  identifier -> OTP -> new password
  // (We re-use signInWithOtp + verifyOtp to sign the user in temporarily,
  // then updateUser to set their new password.)
  // ============================================================
  async function startReset(identifier) {
    if (!identifier) return { ok: false, error: 'Enter your email address.' };
    const email = identifier.trim();
    if (!email.includes('@')) {
      // Username-based reset would require disclosing the email of any
      // account by username, so we require the email here instead.
      return { ok: false, error: 'Please enter the email address you signed up with.' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: 'That doesn\'t look like a valid email address.' };
    }
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (error) return { ok: false, error: _friendly(error) };
    _setPending({ email, purpose: 'reset', sentAt: Date.now() });
    return { ok: true, email };
  }

  async function verifyResetOtp(code) {
    const p = _pending();
    if (!p || p.purpose !== 'reset') return { ok: false, error: 'No reset in progress.' };
    code = String(code || '').trim();
    if (!/^\d{6}$/.test(code)) return { ok: false, error: 'Enter the 6-digit code.' };
    const { error } = await sb.auth.verifyOtp({ email: p.email, token: code, type: 'email' });
    if (error) return { ok: false, error: _friendly(error) };
    p.verified = true;
    _setPending(p);
    return { ok: true, email: p.email };
  }

  async function completeReset(newPassword) {
    const p = _pending();
    if (!p || p.purpose !== 'reset' || !p.verified) return { ok: false, error: 'Reset code not verified.' };
    if (!newPassword || newPassword.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) return { ok: false, error: _friendly(error) };
    _clearPending();
    await _hydrateFromServer();
    return { ok: true };
  }

  // ============================================================
  // Sign out
  // ============================================================
  async function signOut() {
    try { await sb.auth.signOut(); } catch (_) {}
    _sessionCache = null;
    _writeProfileCache(null);
    _clearPending();
    _notifyAuthChange();
  }

  // ============================================================
  // Save profile updates  (display_name, bio, tier, visibility_mask)
  // ============================================================
  async function saveProfile(updates) {
    if (!_sessionCache) return { ok: false, error: 'Not signed in.' };
    const allowed = {};
    if (updates.displayName != null)    allowed.display_name    = updates.displayName;
    if (updates.bio != null)            allowed.bio             = updates.bio;
    if (updates.tier != null)           allowed.tier            = updates.tier;
    if (updates.avatarColor != null)    allowed.avatar_color    = updates.avatarColor;
    if (updates.avatarUrl != null)      allowed.avatar_url      = updates.avatarUrl || null;
    if (updates.visibilityMask != null) allowed.visibility_mask = updates.visibilityMask;
    if (!Object.keys(allowed).length) return { ok: true };
    const { error } = await sb.from('profiles').update(allowed).eq('id', _sessionCache.id);
    if (error) return { ok: false, error: _friendly(error) };
    await _hydrateFromServer();
    return { ok: true };
  }

  // ============================================================
  // Admin: list registrations
  // ============================================================
  async function getRegistrations() {
    const { data, error } = await sb.rpc('list_registrations');
    if (error) {
      console.warn('list_registrations failed', error);
      return [];
    }
    return (data || []).map(r => ({
      email:      r.email,
      username:   r.username,
      university: r.university,
      tier:       r.tier,
      type:       r.type,
      isAdmin:    r.is_admin,
      joinedAt:   r.joined_at ? new Date(r.joined_at).getTime() : Date.now(),
    }));
  }

  // ============================================================
  // Friendly error messages
  // ============================================================
  function _friendly(err) {
    const m = (err && err.message) || String(err);
    const low = m.toLowerCase();
    if (low.includes('rate limit')) return 'Too many attempts. Please wait a minute and try again.';
    if (low.includes('invalid token') || low.includes('expired'))  return 'That code is invalid or has expired. Please request a new one.';
    if (low.includes('email not confirmed')) return 'Email not verified yet. Check your inbox.';
    if (low.includes('user already registered')) return 'An account already exists for this email.';
    if (low.includes('signups not allowed')) return 'New signups are temporarily disabled.';
    return m;
  }

  // ============================================================
  // Avatar — initials + deterministic gradient
  // ============================================================
  function getAvatar(emailOrUser) {
    const email = typeof emailOrUser === 'string' ? emailOrUser : (emailOrUser && emailOrUser.email) || '';
    const user  = typeof emailOrUser === 'string' ? null : emailOrUser;
    const base  = (user && user.username) || (email.split('@')[0] || email || '?');
    const parts = base.split(/[._-]/).filter(Boolean);
    const initials = ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0][1] || ''))).toUpperCase();
    let hash = 0;
    for (let i = 0; i < email.length; i++) hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0;
    const h1 = Math.abs(hash) % 360;
    const h2 = (h1 + 35) % 360;
    return {
      initials: initials || '??',
      gradient: `linear-gradient(135deg, hsl(${h1},65%,45%), hsl(${h2},75%,55%))`,
      hue: h1,
    };
  }
  // avatarHtml(user, size, opts)
  //   opts.gold = true  → force the brand gold gradient (used by the user
  //   pill so it stays visually consistent across every page). When gold
  //   is omitted, the avatar uses a deterministic per-email hue so user
  //   avatars in feeds (reels, leaderboards) remain distinguishable.
  function avatarHtml(emailOrUser, size, opts) {
    size = size || 36;
    opts = opts || {};
    const a    = getAvatar(emailOrUser);
    const grad = opts.gold ? 'linear-gradient(135deg,#c9a030,#e8c060)' : a.gradient;
    return `<div class="ta-avatar" style="width:${size}px;height:${size}px;background:${grad};font-size:${Math.round(size*0.38)}px;">${a.initials}</div>`;
  }

  // ============================================================
  // Shared NAV / FOOTER
  // ============================================================
  function logoSvg() {
    // Transparent background — sits flush on any surface (nav, footer, hero).
    // Geometric, monoline shield + bull/chart spark. No fills, all strokes.
    return `<svg width="30" height="34" viewBox="0 0 40 46" fill="none" aria-hidden="true" style="vertical-align:middle;">
      <path d="M20 2L36 9V22C36 31 29 39 20 43C11 39 4 31 4 22V9L20 2Z" fill="none" stroke="#e8c060" stroke-width="1.6" stroke-linejoin="round"/>
      <polyline points="11,27 17,21 21,25 29,15" fill="none" stroke="#e8c060" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="29" cy="15" r="1.6" fill="#e8c060"/>
    </svg>`;
  }

  // Symbols shown in the live ticker strip above the nav. Order matters
  // (BTC + ETH first because crypto fetches via direct Binance and never
  // misses; AAPL + BHP.AX fall back to TArenaMarket if the proxy isn't
  // wired up — see assets/datafeed.js).
  const TICKER_SYMBOLS = ['BTC', 'ETH', 'AAPL', 'BHP.AX'];

  function tickerItemHtml(sym, price, changePct) {
    const cls = changePct >= 0 ? 'ta-tk-up' : 'ta-tk-dn';
    const arrow = changePct >= 0 ? '▲' : '▼';
    const decimals = price >= 1000 ? 0 : 2;
    const priceTxt = '$' + Number(price).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const pctTxt = (changePct >= 0 ? '+' : '') + Number(changePct).toFixed(2) + '%';
    return `<span class="ta-tk-item"><span class="ta-tk-sym">${sym}</span><span class="ta-tk-px">${priceTxt}</span><span class="${cls}">${arrow} ${pctTxt}</span></span>`;
  }

  function buildTickerStrip() {
    const M = global.TArenaMarket;
    if (!M) return '';
    const items = TICKER_SYMBOLS.map(s => {
      const m = M.find(s);
      if (!m) return '';
      return tickerItemHtml(s, m.price, m.change);
    }).filter(Boolean).join('');
    if (!items) return ''; // no ticker → no leading 30px gap (nav falls back to top:0)
    // Duplicate the row so the marquee animation loops seamlessly.
    return `
      <div class="ta-ticker" id="taTicker" aria-label="Live market ticker">
        <div class="ta-ticker-track">
          <div class="ta-ticker-row">${items}</div>
          <div class="ta-ticker-row" aria-hidden="true">${items}</div>
        </div>
      </div>`;
  }

  // Pull live crypto quotes from Binance (no proxy required) and patch
  // the ticker. Stocks stay on the seeded TArenaMarket values until the
  // data-proxy edge function is deployed.
  async function refreshTickerLive() {
    if (!global.TArenaDatafeed || !global.TArenaDatafeed.fetchQuotes) return;
    try {
      const quotes = await global.TArenaDatafeed.fetchQuotes(TICKER_SYMBOLS);
      const M = global.TArenaMarket;
      if (!M) return;
      let changed = false;
      TICKER_SYMBOLS.forEach((s) => {
        const q = quotes[s];
        if (!q || q.price == null) return;
        const m = M.find(s);
        if (!m) return;
        m.price = +q.price;
        if (q.changePct != null) m.change = +q.changePct;
        changed = true;
      });
      if (changed) repaintTicker();
    } catch (e) { /* silent — keep seed prices */ }
  }

  function repaintTicker() {
    const wrap = document.getElementById('taTicker');
    if (!wrap) return;
    const M = global.TArenaMarket;
    const items = TICKER_SYMBOLS.map(s => {
      const m = M && M.find(s);
      return m ? tickerItemHtml(s, m.price, m.change) : '';
    }).join('');
    wrap.querySelectorAll('.ta-ticker-row').forEach(r => { r.innerHTML = items; });
  }

  // ============================================================
  // Section config for context-aware Groww-style navigation.
  // Each section owns its own context tabs that render in the
  // middle of the main nav. Pages map to a section via PAGE_TO_SECTION
  // (or pass `opts.section` explicitly to renderNav).
  // ============================================================
  const SECTIONS = {
    markets: {
      label: 'Markets', icon: 'fa-chart-line', href: 'trade.html',
      tabs: [
        { label: 'All Markets', d: 'all' }, { label: 'ASX', d: 'asx' },
        { label: 'US Stocks', d: 'us' },     { label: 'Crypto', d: 'crypto' },
        { label: 'Forex', d: 'forex' },
      ],
      // The clickable container gets id="mktTabs" + each tab data-m=""
      // so trade.html's existing market-filter wiring works unchanged.
      tabsId: 'mktTabs', dataAttr: 'm',
    },
    watchlist: {
      label: 'Watchlist', icon: 'fa-star', href: 'trade.html#watchlist',
      tabs: [
        { label: 'My Watchlist', d: 'mine' },
        { label: '+ Add Stock',  d: 'add'  },
      ],
      dataAttr: 'wl',
    },
    portfolio: {
      label: 'Portfolio', icon: 'fa-briefcase', href: 'portfolio.html',
      tabs: [
        { label: 'Overview', d: 'overview' }, { label: 'Holdings', d: 'holdings' },
        { label: 'Orders',   d: 'orders'   }, { label: 'History',  d: 'history'  },
      ],
      dataAttr: 'tab',
    },
    learn: {
      label: 'Learn', icon: 'fa-graduation-cap', href: 'schools.html',
      tabs: [
        { label: 'Schools',     href: 'schools.html'           },
        { label: 'Reels',       href: 'reels.html'             },
        { label: 'My Progress', href: 'schools.html#progress'  },
      ],
    },
    profile: {
      label: 'Profile', icon: 'fa-user', href: 'profile.html',
      tabs: [
        { label: 'Overview',     d: 'overview'     },
        { label: 'Trade History', d: 'trades'      },
        { label: 'Stats',        d: 'stats'        },
        { label: 'Achievements', d: 'achievements' },
      ],
      dataAttr: 'tab',
    },
  };
  const PAGE_TO_SECTION = {
    trade: 'markets', portfolio: 'portfolio',
    schools: 'learn', reels: 'learn',
    profile: 'profile', account: 'profile',
  };
  const SECTION_ORDER = ['markets', 'watchlist', 'portfolio', 'learn', 'profile'];

  function renderNav(activePage, opts) {
    opts = opts || {};
    global.__tarena_nav_active = activePage;
    const sectionKey = opts.section || PAGE_TO_SECTION[activePage] || null;
    const section = sectionKey ? SECTIONS[sectionKey] : null;
    const session = getSession();

    // ---- Top micro section switcher (28px slim bar) ----
    // Lets the user jump between Markets / Watchlist / Portfolio /
    // Learn / Profile from any page. Visible on desktop only — mobile
    // gets the bottom tab bar instead.
    const sectionSwitcherHtml = SECTION_ORDER.map(k => {
      const s = SECTIONS[k];
      const active = k === sectionKey;
      return `<a href="${s.href}" class="ta-secbar-pill ${active ? 'active' : ''}" data-section="${k}">${s.label}</a>`;
    }).join('');

    // ---- Active section pill (sits next to the logo) ----
    const sectionPillHtml = section
      ? `<span class="ta-section-pill"><i class="fa-solid ${section.icon}"></i> ${section.label}</span>`
      : '';

    // ---- Context tabs (per-section middle of main nav) ----
    let contextTabsHtml = '';
    if (section && section.tabs && section.tabs.length) {
      const attr = section.dataAttr;
      const tabsId = section.tabsId ? ` id="${section.tabsId}"` : '';
      contextTabsHtml = `<div class="ta-ctx-tabs"${tabsId} role="tablist">` +
        section.tabs.map((t, i) => {
          if (t.href) {
            // External href tab (e.g. Schools / Reels in Learn section).
            const isActive = (t.href.split('#')[0].split('.html')[0] + '.html') === (activePage + '.html');
            return `<a class="ta-ctx-tab ${isActive ? 'on' : ''}" href="${t.href}">${t.label}</a>`;
          }
          // Data-driven tab — fires a `tarena:nav-tab` CustomEvent on
          // click so each page can wire up its own internal switching.
          // The first tab is active by default.
          const onClass = i === 0 ? ' on' : '';
          return `<button type="button" class="ta-ctx-tab${onClass}" data-${attr}="${t.d}">${t.label}</button>`;
        }).join('') +
      '</div>';
    }

    // ---- Search box + grouped results dropdown ----
    // Same IDs as trade.html's previous custom search so the page-level
    // wiring (selectSymbol etc.) keeps working with zero changes.
    const searchHtml = `
      <div class="ta-search" id="taSearchWrap">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="text" id="searchBox" placeholder="Search BHP, AAPL, BTC..." autocomplete="off"
               aria-label="Search markets"/>
        <span class="ta-kbd" id="searchKbd">⌘K</span>
        <div class="ta-search-results" id="searchResults" role="listbox"></div>
      </div>`;

    // ---- Bell + avatar / Sign in ----
    let accountHtml;
    let drawerAccountHtml;
    if (session) {
      const u = session.user;
      accountHtml = `
        <div class="ta-bell-wrap">
          <button class="ta-bell" id="taBell" aria-label="Notifications">
            <i class="fa-regular fa-bell"></i>
            <span class="ta-bell-dot" aria-hidden="true"></span>
          </button>
          <div class="ta-menu ta-menu-bell" id="taBellMenu">
            <div style="padding:6px 12px 12px;border-bottom:1px solid var(--bdl);margin-bottom:8px;">
              <div style="font-family:'Cinzel',serif;font-size:14px;font-weight:700;color:var(--cream);">Notifications</div>
              <div class="text-muted" style="font-size:11.5px;margin-top:2px;">You're all caught up.</div>
            </div>
            <div style="padding:14px 12px;text-align:center;color:var(--muted);font-size:12.5px;">
              <i class="fa-regular fa-bell-slash" style="font-size:22px;color:var(--gold2);opacity:.6;display:block;margin-bottom:8px;"></i>
              No new notifications yet.
            </div>
          </div>
        </div>
        <div class="ta-account-wrap">
          <button class="ta-pill ta-pill-mini" id="userPill" aria-label="Open account menu">
            ${avatarHtml(u, 32, { gold: true })}
          </button>
          <div class="ta-menu" id="userMenu">
            <a href="profile.html" class="ta-menu-row">
              ${avatarHtml(u, 38, { gold: true })}
              <div>
                <div style="font-weight:700;color:var(--cream);">${u.handle}</div>
                <div class="text-muted" style="font-size:11.5px;">${u.email}</div>
              </div>
            </a>
            <div class="ta-menu-sep"></div>
            <a href="profile.html"   class="ta-menu-link"><i class="fa-solid fa-user"></i> My Profile</a>
            <a href="portfolio.html" class="ta-menu-link"><i class="fa-solid fa-briefcase"></i> Portfolio</a>
            <a href="trade.html"     class="ta-menu-link"><i class="fa-solid fa-chart-line"></i> Trade</a>
            <a href="account.html"   class="ta-menu-link"><i class="fa-solid fa-gear"></i> Settings</a>
            <div class="ta-menu-sep"></div>
            <button class="ta-menu-link ta-menu-logout" id="logoutBtn"><i class="fa-solid fa-arrow-right-from-bracket"></i> Sign out</button>
          </div>
        </div>`;
      drawerAccountHtml = `
        <div class="ta-drawer-user">
          ${avatarHtml(u, 44)}
          <div>
            <div style="font-weight:700;color:var(--cream);font-size:15px;">${u.handle}</div>
            <div class="text-muted" style="font-size:12px;">${u.email}</div>
          </div>
        </div>
        <button class="ta-drawer-link ta-drawer-logout" id="drawerLogoutBtn"><i class="fa-solid fa-arrow-right-from-bracket"></i><span>Sign out</span></button>`;
    } else {
      accountHtml = `<a href="auth.html" class="btn-account ${activePage === 'auth' ? 'active' : ''}">Sign in</a>`;
      drawerAccountHtml = `<a href="auth.html" class="ta-drawer-link ta-drawer-cta"><i class="fa-solid fa-arrow-right-to-bracket"></i><span>Sign in</span></a>`;
    }

    // ---- Install App button (lives in the nav on every page) ----
    const installBtnHtml = `
      <button id="pwaInstallBtn" type="button" class="ta-install-btn" style="display:none;"
              aria-label="Install TradeArena as an app">
        <i class="fa-solid fa-arrow-down-to-bracket"></i><span>Install App</span>
      </button>`;

    // ---- Drawer link list (mobile fallback for non-section pages) ----
    const drawerLinksHtml = SECTION_ORDER.map(k => {
      const s = SECTIONS[k];
      const active = k === sectionKey;
      return `<a href="${s.href}" class="ta-drawer-link ${active ? 'active' : ''}"><i class="fa-solid ${s.icon}"></i><span>${s.label}</span></a>`;
    }).join('');

    // ---- Mobile bottom tab bar (5 sections, app-style) ----
    const bottomBarHtml = `
      <nav class="ta-bottombar" id="taBottomBar" aria-label="Sections">
        ${SECTION_ORDER.map(k => {
          const s = SECTIONS[k];
          const active = k === sectionKey;
          return `<a href="${s.href}" class="ta-bb-tab ${active ? 'on' : ''}" data-section="${k}">
            <i class="fa-solid ${s.icon}"></i><span>${s.label}</span>
          </a>`;
        }).join('')}
      </nav>`;

    const tickerHtml = buildTickerStrip();
    if (document.body) document.body.classList.toggle('ta-has-ticker', !!tickerHtml);

    const html = `
      ${tickerHtml}
      <div class="ta-secbar" id="taSecBar" role="navigation" aria-label="Sections">
        <div class="ta-secbar-inner">${sectionSwitcherHtml}</div>
      </div>
      <nav class="tarena-nav" id="tarenaNav">
        <div class="ta-nav-left">
          <a href="index.html" class="ta-nav-logo">${logoSvg()} <span>Trade<b>Arena</b></span></a>
          ${sectionPillHtml}
        </div>
        <div class="ta-nav-center">${contextTabsHtml}</div>
        <div class="ta-nav-right">
          ${searchHtml}
          ${installBtnHtml}
          ${accountHtml}
          <button class="ta-hamburger" id="taHamburger" aria-label="Open menu" aria-expanded="false">
            <span></span><span></span><span></span>
          </button>
        </div>
      </nav>
      <div class="ta-drawer-scrim" id="taDrawerScrim" aria-hidden="true"></div>
      <aside class="ta-drawer" id="taDrawer" aria-hidden="true">
        <div class="ta-drawer-head">
          <a href="index.html" class="logo" style="font-size:1.15rem;">${logoSvg()} Trade<span>Arena</span></a>
          <button class="ta-drawer-close" id="taDrawerClose" aria-label="Close menu"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <nav class="ta-drawer-nav">${drawerLinksHtml}</nav>
        <div class="ta-drawer-sep"></div>
        ${drawerAccountHtml}
      </aside>
      ${bottomBarHtml}`;

    const mount = document.getElementById('tarena-nav');
    if (!mount) return;
    mount.innerHTML = html;

    // ---- Context tab clicks: switch active state + dispatch event ----
    // Pages can listen to `tarena:nav-tab` (detail: { section, value }) and
    // update their internal UI. The first tab is active by default; click
    // toggles the active class within the tabs container.
    const ctxTabs = mount.querySelector('.ta-ctx-tabs');
    if (ctxTabs && section) {
      ctxTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('button.ta-ctx-tab');
        if (!btn || !ctxTabs.contains(btn)) return;
        ctxTabs.querySelectorAll('.ta-ctx-tab').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        const value = btn.dataset[section.dataAttr] || btn.textContent.trim();
        document.dispatchEvent(new CustomEvent('tarena:nav-tab', {
          detail: { section: sectionKey, value },
        }));
      });
    }

    // ---- Search box: live grouped dropdown across markets ----------
    // On a non-trade page, clicking a result navigates to
    // `trade.html?symbol=XXX`. trade.html overrides this binding with
    // its own selectSymbol() flow so the same input stays familiar.
    wireNavSearch(activePage);

    // ---- PWA Install button ----------------------------------------
    // Captures `beforeinstallprompt`, reveals the gold pill, then replays
    // the prompt on click. Hides itself permanently on `appinstalled`
    // or when already running standalone.
    wireInstallButton();

    // Account dropdown + notification bell. Bell + pill share an
    // outside-click closer that closes whichever isn't being interacted
    // with, so opening one auto-dismisses the other.
    const pill     = document.getElementById('userPill');
    const menu     = document.getElementById('userMenu');
    const bell     = document.getElementById('taBell');
    const bellMenu = document.getElementById('taBellMenu');
    const logoutBtn = document.getElementById('logoutBtn');
    if (pill && menu) {
      pill.addEventListener('click', e => {
        e.stopPropagation();
        if (bellMenu) bellMenu.classList.remove('open');
        menu.classList.toggle('open');
      });
    }
    if (bell && bellMenu) {
      bell.addEventListener('click', e => {
        e.stopPropagation();
        if (menu) menu.classList.remove('open');
        bellMenu.classList.toggle('open');
      });
    }
    document.addEventListener('click', e => {
      if (menu && pill && !menu.contains(e.target) && !pill.contains(e.target)) menu.classList.remove('open');
      if (bellMenu && bell && !bellMenu.contains(e.target) && !bell.contains(e.target)) bellMenu.classList.remove('open');
    });
    const doSignOut = async () => { await signOut(); window.location.href = 'index.html'; };
    if (logoutBtn) logoutBtn.addEventListener('click', doSignOut);
    const drawerLogoutBtn = document.getElementById('drawerLogoutBtn');
    if (drawerLogoutBtn) drawerLogoutBtn.addEventListener('click', doSignOut);

    // Mobile drawer
    const ham    = document.getElementById('taHamburger');
    const drawer = document.getElementById('taDrawer');
    const scrim  = document.getElementById('taDrawerScrim');
    const closer = document.getElementById('taDrawerClose');
    const openDrawer = () => {
      drawer.classList.add('open');
      scrim.classList.add('open');
      ham.classList.add('on');
      ham.setAttribute('aria-expanded', 'true');
      drawer.setAttribute('aria-hidden', 'false');
    };
    const closeDrawer = () => {
      drawer.classList.remove('open');
      scrim.classList.remove('open');
      ham.classList.remove('on');
      ham.setAttribute('aria-expanded', 'false');
      drawer.setAttribute('aria-hidden', 'true');
    };
    if (ham)    ham.addEventListener('click', openDrawer);
    if (closer) closer.addEventListener('click', closeDrawer);
    if (scrim)  scrim.addEventListener('click', closeDrawer);
    // Escape key to close the drawer (one shared listener; replaces the
    // previous one on re-render so we don't leak handlers across pages).
    window.removeEventListener('keydown', global.__tarena_nav_keydown || (() => {}));
    const onKeydown = (e) => {
      if (e.key === 'Escape' && drawer && drawer.classList.contains('open')) closeDrawer();
    };
    global.__tarena_nav_keydown = onKeydown;
    window.addEventListener('keydown', onKeydown);

    // Sticky-on-scroll: add `.scrolled` for stronger blur + shadow
    const navEl = document.getElementById('tarenaNav');
    const onScroll = () => {
      if (!navEl) return;
      if (window.scrollY > 8) navEl.classList.add('scrolled');
      else navEl.classList.remove('scrolled');
    };
    window.removeEventListener('scroll', global.__tarena_nav_scroll || (() => {}));
    global.__tarena_nav_scroll = onScroll;
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // Kick off a one-shot live refresh (crypto only) — no need to await.
    refreshTickerLive();
  }

  // ============================================================
  // Live nav search — grouped dropdown across the simulated market
  // catalogue. Re-wired on every renderNav so it works after page
  // navigations / SPA-style swaps. Falls back gracefully if
  // TArenaMarket isn't loaded yet.
  // ============================================================
  function wireNavSearch(activePage) {
    const box  = document.getElementById('searchBox');
    const out  = document.getElementById('searchResults');
    const wrap = document.getElementById('taSearchWrap');
    if (!box || !out || !wrap) return;

    // Lazy-load market.js on pages that don't already include it, so
    // the shared search dropdown has a catalogue to query everywhere.
    // Idempotent: subsequent calls reuse the in-flight promise.
    if (!global.TArenaMarket && !global.__tarena_market_loading) {
      global.__tarena_market_loading = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = 'assets/market.js';
        s.async = true;
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      });
    }

    // Group icons + colours for the result rows. Stocks get a gold dot,
    // crypto orange, forex blue — matches the section colour cues.
    const TYPE_META = {
      asx:    { label: 'STOCKS', colour: '#e8c060' },
      us:     { label: 'STOCKS', colour: '#60a5fa' },
      crypto: { label: 'CRYPTO', colour: '#f59e0b' },
      forex:  { label: 'FOREX',  colour: '#a78bfa' },
    };

    function close() { out.classList.remove('open'); }
    function open()  { out.classList.add('open');    }

    function render(q) {
      const M = global.TArenaMarket;
      if (!M) {
        out.innerHTML = '<div class="ta-sr-empty">Loading markets…</div>';
        open();
        // If market.js is being lazy-loaded, retry once it resolves.
        if (global.__tarena_market_loading) {
          global.__tarena_market_loading.then(() => { if (box.value.trim()) render(box.value.trim().toLowerCase()); });
        }
        return;
      }
      // TArenaMarket exposes either .all() or an internal catalogue;
      // prefer .all() if available, otherwise fall back to common syms.
      const list = (typeof M.all === 'function') ? M.all() : (M.symbols || []);
      const matches = list
        .filter(it => {
          const sym = (it.symbol || '').toLowerCase();
          const name = (it.name || '').toLowerCase();
          return sym.includes(q) || name.includes(q);
        })
        .slice(0, 12);

      if (!matches.length) {
        out.innerHTML = '<div class="ta-sr-empty">No matches for &ldquo;' + escapeHtml(q) + '&rdquo;</div>';
        return open();
      }

      // Group rows by market type for the section headings.
      const groups = {};
      matches.forEach(it => {
        const k = it.market || 'asx';
        (groups[k] = groups[k] || []).push(it);
      });

      out.innerHTML = Object.keys(groups).map(k => {
        const meta = TYPE_META[k] || { label: k.toUpperCase(), colour: '#e8c060' };
        const rows = groups[k].map(it => {
          const up = (it.change || 0) >= 0;
          const pxStr = '$' + Number(it.price || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const pctStr = (up ? '+' : '') + Number(it.change || 0).toFixed(2) + '%';
          return `<button type="button" class="ta-sr-row" data-sym="${escapeHtml(it.symbol)}">
              <span class="ta-sr-dot" style="background:${meta.colour};"></span>
              <span class="ta-sr-sym">${escapeHtml((it.symbol || '').replace('.AX',''))}</span>
              <span class="ta-sr-name">${escapeHtml(it.name || '')}</span>
              <span class="ta-sr-px">${pxStr}</span>
              <span class="ta-sr-pct ${up ? 'up' : 'dn'}">${pctStr}</span>
            </button>`;
        }).join('');
        return `<div class="ta-sr-group"><div class="ta-sr-head">${meta.label}</div>${rows}</div>`;
      }).join('');

      // Each row navigates to the trade page with the symbol in the URL.
      // trade.html intercepts this on load (selectSymbol via ?symbol=).
      out.querySelectorAll('.ta-sr-row').forEach(r => {
        r.addEventListener('click', () => {
          const sym = r.dataset.sym;
          if (activePage === 'trade' && typeof global.selectSymbol === 'function') {
            global.selectSymbol(sym);
            box.value = '';
            close();
          } else {
            window.location.href = 'trade.html?symbol=' + encodeURIComponent(sym);
          }
        });
      });
      open();
    }

    let timer = null;
    box.addEventListener('input', () => {
      clearTimeout(timer);
      const q = box.value.trim().toLowerCase();
      if (!q) { close(); return; }
      timer = setTimeout(() => render(q), 140);
    });
    box.addEventListener('focus', () => { if (box.value.trim()) open(); });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });

    // Global ⌘K / Ctrl+K shortcut focuses the search input from anywhere.
    window.removeEventListener('keydown', global.__tarena_nav_search_key || (() => {}));
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        box.focus();
        box.select();
      }
      if (e.key === 'Escape' && document.activeElement === box) {
        box.value = '';
        close();
        box.blur();
      }
    };
    global.__tarena_nav_search_key = onKey;
    window.addEventListener('keydown', onKey);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ============================================================
  // PWA install button wiring — shared across every page that has
  // the renderNav-emitted #pwaInstallBtn. Listens for the browser's
  // beforeinstallprompt event, reveals the button, then replays the
  // captured prompt on click. Idempotent: re-running on each page
  // reuses the cached deferredPrompt if the browser fired it earlier.
  // ============================================================
  function wireInstallButton() {
    const btn = document.getElementById('pwaInstallBtn');
    if (!btn) return;
    const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches
                    || window.navigator.standalone === true;
    if (standalone) { btn.style.display = 'none'; return; }

    // The browser only fires beforeinstallprompt once. Cache it on
    // the global so a re-render (or a later page) can still use it.
    if (!global.__tarena_install_listener) {
      global.__tarena_install_listener = true;
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        global.__tarena_deferred_install = e;
        const cur = document.getElementById('pwaInstallBtn');
        if (cur) cur.style.display = 'inline-flex';
      });
      window.addEventListener('appinstalled', () => {
        global.__tarena_deferred_install = null;
        const cur = document.getElementById('pwaInstallBtn');
        if (cur) cur.style.display = 'none';
      });
    }
    if (global.__tarena_deferred_install) btn.style.display = 'inline-flex';

    btn.onclick = async () => {
      const dp = global.__tarena_deferred_install;
      if (!dp) return;
      dp.prompt();
      try { await dp.userChoice; } catch (_) {}
      global.__tarena_deferred_install = null;
      btn.style.display = 'none';
    };
  }

  function renderFooter() {
    const session = getSession();
    const year = new Date().getFullYear();
    // Three-column company footer + disclaimer + (signed-out only) sign-in nudge.
    const signInHtml = session ? '' : `
      <div class="ta-foot-cta">
        <a href="auth.html">Already have an account? <strong>Log in →</strong></a>
      </div>`;
    const html = `
      <footer class="tarena-footer">
        <div class="ta-foot-grid">
          <div class="ta-foot-brand">
            <div class="logo" style="font-size:1.4rem;margin-bottom:12px;font-family:'DM Sans',sans-serif;font-weight:700;letter-spacing:-.01em;">
              ${logoSvg()} <span style="color:var(--cream);">Trade</span><span style="color:var(--gold2);">Arena</span>
            </div>
            <p class="ta-foot-blurb">Strategy-first paper trading for Australian uni students. ASX, US &amp; crypto. Zero risk. Built in Sydney.</p>
            <div class="ta-foot-social">
              <a href="https://x.com/tradearena07" target="_blank" rel="noopener" aria-label="Twitter / X"><i class="fa-brands fa-x-twitter"></i></a>
              <a href="https://instagram.com/_tradearena_" target="_blank" rel="noopener" aria-label="Instagram"><i class="fa-brands fa-instagram"></i></a>
              <a href="mailto:tradearena07@gmail.com" aria-label="Email"><i class="fa-solid fa-envelope"></i></a>
            </div>
          </div>
          <div class="ta-foot-col">
            <h4>Product</h4>
            <a href="trade.html">Markets</a>
            <a href="reels.html">Learn</a>
            <a href="schools.html">School</a>
            <a href="portfolio.html">Portfolio</a>
          </div>
          <div class="ta-foot-col">
            <h4>Company</h4>
            <a href="about.html">About</a>
            <a href="contact.html">Contact</a>
            <a href="careers.html">Careers</a>
            <a href="press.html">Press</a>
          </div>
          <div class="ta-foot-col">
            <h4>Legal</h4>
            <a href="terms.html">Terms of Use</a>
            <a href="privacy.html">Privacy Policy</a>
            <a href="risk.html">Risk Disclaimer</a>
            <a href="cookies.html">Cookie Policy</a>
          </div>
        </div>

        <div class="ta-foot-disclaimer">
          <strong>Important:</strong> TradeArena is an educational paper-trading platform.
          All trades are simulated — no real money is at risk and no real orders are executed.
          Nothing on this site constitutes financial product advice, a recommendation, or an offer
          to buy or sell any security. Past simulated performance is not indicative of future
          results. You should consider obtaining personal advice from a licensed Australian
          financial adviser (AFSL) before making investment decisions. Market data is provided
          by third-party sources and may be delayed or inaccurate.
        </div>

        <div class="ta-foot-bottom">
          <span>© ${year} TradeArena · Made with care in Sydney, Australia</span>
          <span class="ta-foot-bottom-links">
            <a href="about.html">About</a>
            <a href="contact.html">Contact</a>
            <a href="risk.html">Risk</a>
          </span>
        </div>
        ${signInHtml}
      </footer>`;
    const mount = document.getElementById('tarena-footer');
    if (mount) mount.innerHTML = html;
  }

  function fmtMoney(n, opts) {
    opts = opts || {};
    const sign = (opts.sign && n > 0) ? '+' : '';
    const abs = Math.abs(n);
    const decimals = opts.decimals != null ? opts.decimals : (abs >= 1000 ? 0 : 2);
    return sign + (n < 0 ? '-' : '') + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  function fmtPct(n) {
    const sign = n > 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }

  // ============================================================
  // Exports
  // ============================================================
  global.TArenaAuth = {
    // sign-up
    startSignup, verifySignupOtp, completeSignup, suggestUsername, isUsernameAvailable,
    // log in
    login,
    // password reset
    startReset, verifyResetOtp, completeReset,
    // session
    getSession, requireAuth, signOut, reloadSession, onAuthChange,
    // profile
    getProfile, saveProfile,
    // helpers
    isStudentEmail, getUniversity,
    // admin
    getRegistrations,
  };
  global.TArenaUI = { renderNav, renderFooter, fmtMoney, fmtPct, logoSvg, getAvatar, avatarHtml, repaintTicker };

})(window);
