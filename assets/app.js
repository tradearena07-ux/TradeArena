// TradeArena — shared client logic
// Demo-mode auth using localStorage. Two flows:
//   - Sign up: email → OTP verification → set username + password (one-time)
//   - Log in: username/email + password (no OTP)
//   - Forgot password: email → OTP → set new password
(function (global) {
  const SESSION_KEY  = 'tarena_session';
  const PENDING_KEY  = 'tarena_pending_otp';
  const USERS_KEY    = 'tarena_users';          // { [email]: { email, username, password, ... } }
  const REGS_KEY     = 'tarena_registrations';  // lightweight summary for admin
  const PROFILES_KEY = 'tarena_profiles';

  function genCode() {
    let c = '';
    for (let i = 0; i < 6; i++) c += Math.floor(Math.random() * 10);
    return c;
  }

  function isStudentEmail(email) {
    const lower = (email || '').toLowerCase();
    return lower.endsWith('.edu.au') || lower.endsWith('.ac.nz') || lower.endsWith('monash.edu');
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

  // ------- Storage helpers -------
  function _users() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function _saveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }
  function _profiles() {
    try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '{}'); } catch (e) { return {}; }
  }

  function findUser(identifier) {
    const id = (identifier || '').trim().toLowerCase();
    if (!id) return null;
    const all = _users();
    if (all[id]) return all[id];                                // by email
    for (const k in all) if (all[k].username === id) return all[k]; // by username
    return null;
  }
  function userExists(email) { return !!_users()[(email || '').trim().toLowerCase()]; }

  // ------- Session -------
  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  }
  function setSession(user) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user, createdAt: Date.now() }));
  }
  function signOut() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(PENDING_KEY);
  }
  function requireAuth() {
    const s = getSession();
    if (!s) { window.location.href = 'auth.html'; return null; }
    return s;
  }

  function _makeSessionUser(u) {
    return {
      email:      u.email,
      username:   u.username,
      handle:     '@' + u.username,
      university: u.university,
      type:       u.type,
      joinedAt:   u.createdAt,
    };
  }

  // ------- Sign-up flow (email → OTP → set credentials) -------
  function startSignup(email, type) {
    email = (email || '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'Please enter your email address.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'That doesn\'t look like a valid email address.' };
    if (type === 'student' && !isStudentEmail(email)) {
      return { ok: false, error: 'Please use a university email (.edu.au) or switch to <strong>Public</strong> above.' };
    }
    if (userExists(email)) {
      return { ok: false, error: 'An account already exists for this email. <a href="#" onclick="window.__switchTab&&window.__switchTab(\'login\');return false;">Log in instead →</a>' };
    }
    const code = genCode();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    localStorage.setItem(PENDING_KEY, JSON.stringify({ email, code, expiresAt, type, purpose: 'signup' }));
    return { ok: true, code, expiresAt, email };
  }

  function verifySignupOtp(code) {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return { ok: false, error: 'No code pending. Request a new one.' };
    let p; try { p = JSON.parse(raw); } catch (e) { return { ok: false, error: 'Pending code corrupted.' }; }
    if (p.purpose !== 'signup') return { ok: false, error: 'Wrong context — start sign-up over.' };
    if (Date.now() > p.expiresAt) return { ok: false, error: 'Code expired. Request a new one.' };
    if (String(code) !== String(p.code)) return { ok: false, error: 'Incorrect code. Please try again.' };
    p.verified = true;
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    return { ok: true, email: p.email, type: p.type };
  }

  function suggestUsername(email) {
    const local = (email || '').split('@')[0] || '';
    return local.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'trader' + Math.floor(Math.random() * 9999);
  }

  function isUsernameTaken(username) {
    username = (username || '').toLowerCase();
    const all = _users();
    for (const k in all) if (all[k].username === username) return true;
    return false;
  }

  function completeSignup(username, password) {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return { ok: false, error: 'Verification expired. Start over.' };
    let p; try { p = JSON.parse(raw); } catch (e) { return { ok: false, error: 'Bad state.' }; }
    if (!p.verified) return { ok: false, error: 'Email not verified yet.' };
    username = (username || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{2,19}$/.test(username)) {
      return { ok: false, error: 'Username must be 3-20 chars, start with a letter (a-z, 0-9, _).' };
    }
    if (!password || password.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
    if (isUsernameTaken(username)) return { ok: false, error: 'That username is already taken.' };

    const all = _users();
    const user = {
      email: p.email,
      username,
      password,                         // demo only — would be hashed server-side
      university: getUniversity(p.email),
      type: p.type,
      createdAt: Date.now(),
    };
    all[p.email] = user;
    _saveUsers(all);

    let regs = []; try { regs = JSON.parse(localStorage.getItem(REGS_KEY) || '[]'); } catch (_) {}
    if (!regs.find(r => r.email === p.email)) {
      regs.push({ email: p.email, username, university: user.university, type: p.type, joinedAt: user.createdAt });
      localStorage.setItem(REGS_KEY, JSON.stringify(regs));
    }
    localStorage.removeItem(PENDING_KEY);
    setSession(_makeSessionUser(user));
    return { ok: true };
  }

  // ------- Log in (no OTP) -------
  function login(identifier, password) {
    if (!identifier || !password) return { ok: false, error: 'Enter your email/username and password.' };
    const u = findUser(identifier);
    if (!u) return { ok: false, error: 'No account found with that email or username.' };
    if (u.password !== password) return { ok: false, error: 'Incorrect password.' };
    setSession(_makeSessionUser(u));
    return { ok: true };
  }

  // ------- Password reset (forgot password) -------
  function startReset(identifier) {
    const u = findUser(identifier);
    if (!u) return { ok: false, error: 'No account found with that email or username.' };
    const code = genCode();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    localStorage.setItem(PENDING_KEY, JSON.stringify({ email: u.email, code, expiresAt, purpose: 'reset' }));
    return { ok: true, code, expiresAt, email: u.email };
  }
  function verifyResetOtp(code) {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return { ok: false, error: 'No reset pending.' };
    let p; try { p = JSON.parse(raw); } catch (e) { return { ok: false, error: 'Bad state.' }; }
    if (p.purpose !== 'reset') return { ok: false, error: 'Invalid context.' };
    if (Date.now() > p.expiresAt) return { ok: false, error: 'Code expired.' };
    if (String(code) !== String(p.code)) return { ok: false, error: 'Incorrect code.' };
    p.verified = true;
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    return { ok: true, email: p.email };
  }
  function completeReset(newPassword) {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return { ok: false, error: 'Reset expired.' };
    let p; try { p = JSON.parse(raw); } catch (e) { return { ok: false, error: 'Bad state.' }; }
    if (!p.verified) return { ok: false, error: 'OTP not verified.' };
    if (!newPassword || newPassword.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
    const all = _users();
    if (!all[p.email]) return { ok: false, error: 'User not found.' };
    all[p.email].password = newPassword;
    _saveUsers(all);
    localStorage.removeItem(PENDING_KEY);
    setSession(_makeSessionUser(all[p.email]));
    return { ok: true };
  }

  // ------- Profile (per-user editable data) -------
  function getProfile(email) {
    const all = _profiles();
    if (all[email]) return all[email];
    const local = (email || '').split('@')[0];
    const user = _users()[email];
    const display = user ? user.username : local;
    const uni = getUniversity(email);
    return {
      email,
      displayName: (display || email).replace(/_/g, ' '),
      bio: uni === 'Public' ? 'Independent trader · Markets enthusiast' : `Trader at ${uni}`,
      tier: 'Member',
    };
  }
  function saveProfile(email, updates) {
    const all = _profiles();
    all[email] = Object.assign(getProfile(email), updates);
    localStorage.setItem(PROFILES_KEY, JSON.stringify(all));
    return all[email];
  }

  // ------- Misc -------
  function getRegistrations() {
    try { return JSON.parse(localStorage.getItem(REGS_KEY) || '[]'); } catch (e) { return []; }
  }
  function clearAllData() {
    [SESSION_KEY, PENDING_KEY, USERS_KEY, REGS_KEY, PROFILES_KEY, 'tarena_orders', 'tarena_watchlist'].forEach(k => localStorage.removeItem(k));
  }

  function seedDemoUsers() {
    // Seed demo accounts. All use password `demo1234`.
    const seed = [
      { email: 'alex.chen@student.unsw.edu.au',   username: 'alexchen',  type: 'student', days: 12 },
      { email: 'mia.lee@usyd.edu.au',             username: 'mialee',    type: 'student', days: 9  },
      { email: 'jordan.kim@uts.edu.au',           username: 'jkim',      type: 'student', days: 7  },
      { email: 'sarah.patel@monash.edu',          username: 'sarahp',    type: 'student', days: 5  },
      { email: 'noah.brown@unimelb.edu.au',       username: 'noahb',     type: 'student', days: 3  },
      { email: 'ella.smith@anu.edu.au',           username: 'esmith',    type: 'student', days: 2  },
      { email: 'priya.shah@uq.edu.au',            username: 'priya',     type: 'student', days: 2  },
      { email: 'liam.osullivan@gmail.com',        username: 'liamos',    type: 'public',  days: 1  },
    ];
    const users = _users();
    let regs = []; try { regs = JSON.parse(localStorage.getItem(REGS_KEY) || '[]'); } catch (_) {}
    let dirty = false;
    seed.forEach(s => {
      const ts = Date.now() - 86400000 * s.days;
      if (!users[s.email]) {
        users[s.email] = {
          email: s.email, username: s.username, password: 'demo1234',
          university: getUniversity(s.email), type: s.type, createdAt: ts,
        };
        dirty = true;
      }
      if (!regs.find(r => r.email === s.email)) {
        regs.push({ email: s.email, username: s.username, university: getUniversity(s.email), type: s.type, joinedAt: ts });
      }
    });
    if (dirty) _saveUsers(users);
    localStorage.setItem(REGS_KEY, JSON.stringify(regs));
  }

  // ------- Avatar (initials + deterministic gradient) -------
  function getAvatar(emailOrUser) {
    const email = typeof emailOrUser === 'string' ? emailOrUser : (emailOrUser && emailOrUser.email) || '';
    const user = typeof emailOrUser === 'string' ? null : emailOrUser;
    const base = (user && user.username) || (email.split('@')[0] || email || '?');
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

  function avatarHtml(emailOrUser, size) {
    size = size || 36;
    const a = getAvatar(emailOrUser);
    return `<div class="ta-avatar" style="width:${size}px;height:${size}px;background:${a.gradient};font-size:${Math.round(size*0.38)}px;">${a.initials}</div>`;
  }

  // ---------- Shared NAV / FOOTER ----------
  function logoSvg() {
    return `<svg width="28" height="32" viewBox="0 0 40 46" fill="none" aria-hidden="true">
      <path d="M20 2L36 9V22C36 31 29 39 20 43C11 39 4 31 4 22V9L20 2Z" fill="#091528" stroke="#c9a030" stroke-width="1"/>
      <path d="M20 8L30 12.5V21C30 26.5 25.5 31.5 20 34C14.5 31.5 10 26.5 10 21V12.5L20 8Z" fill="none" stroke="#e8c060" stroke-width="0.75" opacity="0.6"/>
      <polyline points="12,24 17,19 20,22 28,13" fill="none" stroke="#c9a030" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;
  }

  function renderNav(activePage) {
    const links = [
      { id: 'trade',     href: 'trade.html',     label: 'Markets' },
      { id: 'portfolio', href: 'portfolio.html', label: 'Portfolio' },
      { id: 'profile',   href: 'profile.html',   label: 'Profile' },
      { id: 'leagues',   href: '#leagues',       label: 'Leagues' },
    ];
    const session = getSession();
    const linksHtml = links.map(l =>
      `<a href="${l.href}" class="${activePage === l.id ? 'active' : ''}">${l.label}</a>`
    ).join('');

    let accountHtml;
    if (session) {
      const u = session.user;
      accountHtml = `
        <div class="ta-account-wrap">
          <button class="ta-pill" id="userPill" aria-label="Open account menu">
            ${avatarHtml(u, 30)}
            <span class="ta-pill-name">${u.handle}</span>
            <i class="fa-solid fa-chevron-down" style="font-size:10px;color:var(--muted);"></i>
          </button>
          <div class="ta-menu" id="userMenu">
            <a href="profile.html" class="ta-menu-row">
              ${avatarHtml(u, 38)}
              <div>
                <div style="font-weight:600;color:var(--cream);">${u.handle}</div>
                <div class="text-muted" style="font-size:11.5px;">${u.email}</div>
              </div>
            </a>
            <div class="ta-menu-sep"></div>
            <a href="profile.html" class="ta-menu-link"><i class="fa-solid fa-user"></i> View profile</a>
            <a href="portfolio.html" class="ta-menu-link"><i class="fa-solid fa-briefcase"></i> Portfolio</a>
            <a href="trade.html" class="ta-menu-link"><i class="fa-solid fa-chart-line"></i> Markets</a>
            <div class="ta-menu-sep"></div>
            <button class="ta-menu-link ta-menu-logout" id="logoutBtn"><i class="fa-solid fa-arrow-right-from-bracket"></i> Sign out</button>
          </div>
        </div>`;
    } else {
      accountHtml = `<a href="auth.html" class="btn-account ${activePage === 'auth' ? 'active' : ''}">Sign in</a>`;
    }

    const html = `
      <nav class="tarena-nav">
        <a href="index.html" class="logo">${logoSvg()} Trade<span>Arena</span></a>
        <div class="nav-links">${linksHtml}</div>
        <div class="nav-account">${accountHtml}</div>
      </nav>`;

    const mount = document.getElementById('tarena-nav');
    if (mount) {
      mount.innerHTML = html;
      const pill = document.getElementById('userPill');
      const menu = document.getElementById('userMenu');
      const logoutBtn = document.getElementById('logoutBtn');
      if (pill && menu) {
        pill.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
        document.addEventListener('click', e => {
          if (!menu.contains(e.target) && e.target !== pill) menu.classList.remove('open');
        });
      }
      if (logoutBtn) logoutBtn.addEventListener('click', () => {
        signOut();
        window.location.href = 'index.html';
      });
    }
  }

  function renderFooter() {
    const html = `
      <footer class="tarena-footer">
        <div class="row">
          <div>
            <div class="logo" style="font-size:1.5rem;margin-bottom:14px;">${logoSvg()} Trade<span>Arena</span></div>
            <p class="text-muted" style="max-width:340px;font-size:14px;line-height:1.6;">
              Paper trading platform for Australian university students. Real markets. Zero risk. Built in Sydney.
            </p>
          </div>
          <div style="text-align:right;">
            <p style="font-family:'Cinzel',serif;font-size:12px;letter-spacing:.2em;color:var(--gold);margin-bottom:8px;">© 2026 TRADEARENA</p>
            <a href="auth.html" class="text-muted" style="font-size:13px;">Already have an account? Log in →</a>
          </div>
        </div>
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

  global.TArenaAuth = {
    startSignup, verifySignupOtp, completeSignup, suggestUsername, isUsernameTaken,
    login,
    startReset, verifyResetOtp, completeReset,
    getSession, signOut, requireAuth,
    isStudentEmail, getUniversity, getRegistrations,
    clearAllData, seedDemoUsers,
    getProfile, saveProfile,
    findUser, userExists,
  };
  global.TArenaUI = { renderNav, renderFooter, fmtMoney, fmtPct, logoSvg, getAvatar, avatarHtml };
})(window);
