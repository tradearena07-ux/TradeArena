// TradeArena — shared client logic
// Demo-mode auth using localStorage (works fully offline / on a static host).
(function (global) {
  const SESSION_KEY = 'tarena_session';
  const PENDING_KEY = 'tarena_pending_otp';
  const REGS_KEY    = 'tarena_registrations';
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

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  }
  function setSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(PENDING_KEY);
  }

  // ------- Profile (per-user editable data) -------
  function _profiles() {
    try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '{}'); } catch (e) { return {}; }
  }
  function getProfile(email) {
    const all = _profiles();
    if (all[email]) return all[email];
    // Default profile
    const local = (email || '').split('@')[0];
    const display = local.split(/[._-]/).map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : '').join(' ').trim() || email;
    const uni = getUniversity(email);
    return {
      email,
      displayName: display,
      bio: uni === 'Public' ? 'Trading the markets · Paper mode' : `Studying at ${uni} · Paper mode warrior`,
      tier: 'Bronze Warrior',
      country: '🇦🇺',
    };
  }
  function saveProfile(email, updates) {
    const all = _profiles();
    all[email] = Object.assign(getProfile(email), updates);
    localStorage.setItem(PROFILES_KEY, JSON.stringify(all));
    return all[email];
  }

  // sendOtp(email, type) → { ok, code, expiresAt, error }
  function sendOtp(email, type) {
    email = (email || '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'Please enter your email address.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: 'That doesn\'t look like a valid email address.' };
    }
    if (type === 'student' && !isStudentEmail(email)) {
      return { ok: false, error: 'Please use a university email (.edu.au) or switch to <strong>Public</strong> access above.' };
    }
    const code = genCode();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    localStorage.setItem(PENDING_KEY, JSON.stringify({ email, code, expiresAt, type }));
    return { ok: true, code, expiresAt, email };
  }

  function verifyOtp(code) {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return { ok: false, error: 'No code pending. Request a new one.' };
    let p; try { p = JSON.parse(raw); } catch (e) { return { ok: false, error: 'Pending code is corrupted.' }; }
    if (Date.now() > p.expiresAt) return { ok: false, error: 'Code expired. Request a new one.' };
    if (String(code) !== String(p.code))  return { ok: false, error: 'Incorrect code. Please try again.' };

    const session = {
      user: {
        email:      p.email,
        handle:     '@' + p.email.split('@')[0].replace(/[^a-z0-9_]/g, '_').toLowerCase(),
        username:   p.email.split('@')[0].replace(/[^a-z0-9_]/g, '_').toLowerCase(),
        university: getUniversity(p.email),
        type:       p.type,
        joinedAt:   Date.now(),
      },
      createdAt: Date.now(),
    };
    setSession(session);

    // Track registration
    let regs = [];
    try { regs = JSON.parse(localStorage.getItem(REGS_KEY) || '[]'); } catch (_) {}
    if (!regs.find(r => r.email === p.email)) {
      regs.push({
        email:      p.email,
        university: getUniversity(p.email),
        type:       p.type,
        joinedAt:   Date.now(),
      });
      localStorage.setItem(REGS_KEY, JSON.stringify(regs));
    }
    localStorage.removeItem(PENDING_KEY);
    return { ok: true, session };
  }

  function signOut() { clearSession(); }

  function requireAuth() {
    const s = getSession();
    if (!s) {
      window.location.href = 'auth.html';
      return null;
    }
    return s;
  }

  function getRegistrations() {
    try { return JSON.parse(localStorage.getItem(REGS_KEY) || '[]'); } catch (e) { return []; }
  }

  function clearAllData() {
    [SESSION_KEY, PENDING_KEY, REGS_KEY, PROFILES_KEY, 'tarena_orders', 'tarena_watchlist'].forEach(k => localStorage.removeItem(k));
  }

  function seedDemoUsers() {
    const seed = [
      { email: 'alex.chen@student.unsw.edu.au',   university: 'UNSW Sydney',          type: 'student', joinedAt: Date.now() - 86400000 * 12 },
      { email: 'mia.lee@usyd.edu.au',             university: 'University of Sydney', type: 'student', joinedAt: Date.now() - 86400000 * 9  },
      { email: 'jordan.kim@uts.edu.au',           university: 'UTS Sydney',           type: 'student', joinedAt: Date.now() - 86400000 * 7  },
      { email: 'sarah.patel@monash.edu',          university: 'Monash University',    type: 'student', joinedAt: Date.now() - 86400000 * 5  },
      { email: 'noah.brown@unimelb.edu.au',       university: 'University of Melbourne', type: 'student', joinedAt: Date.now() - 86400000 * 3 },
      { email: 'ella.smith@anu.edu.au',           university: 'ANU',                  type: 'student', joinedAt: Date.now() - 86400000 * 2 },
      { email: 'priya.shah@uq.edu.au',            university: 'University of Queensland', type: 'student', joinedAt: Date.now() - 86400000 * 2 },
      { email: 'liam.osullivan@gmail.com',        university: 'Public',               type: 'public',  joinedAt: Date.now() - 86400000 * 1 },
    ];
    const existing = getRegistrations();
    const merged = existing.slice();
    seed.forEach(s => { if (!merged.find(r => r.email === s.email)) merged.push(s); });
    localStorage.setItem(REGS_KEY, JSON.stringify(merged));
  }

  // ------- Avatar (initials + deterministic gradient) -------
  function getAvatar(emailOrUser) {
    const email = typeof emailOrUser === 'string' ? emailOrUser : (emailOrUser && emailOrUser.email) || '';
    const local = email.split('@')[0] || email || '?';
    const parts = local.split(/[._-]/).filter(Boolean);
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

  // ---------- Shared NAV / FOOTER renderers ----------
  function logoSvg() {
    return `<svg width="30" height="34" viewBox="0 0 40 46" fill="none" aria-hidden="true">
      <path d="M20 2L36 9V22C36 31 29 39 20 43C11 39 4 31 4 22V9L20 2Z" fill="#091528" stroke="#c9a030" stroke-width="1"/>
      <path d="M20 8L30 12.5V21C30 26.5 25.5 31.5 20 34C14.5 31.5 10 26.5 10 21V12.5L20 8Z" fill="none" stroke="#e8c060" stroke-width="0.75" opacity="0.6"/>
      <text x="20" y="27" text-anchor="middle" font-family="serif" font-size="12" font-weight="bold" fill="#e8c060">&#8383;</text>
      <polyline points="12,24 17,19 20,22 28,13" fill="none" stroke="#c9a030" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
  }

  function renderNav(activePage) {
    const links = [
      { id: 'trade',     href: 'trade.html',     label: 'Trade' },
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
            ${avatarHtml(u, 32)}
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
            <a href="trade.html" class="ta-menu-link"><i class="fa-solid fa-bolt"></i> Trade</a>
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
        pill.addEventListener('click', e => {
          e.stopPropagation();
          menu.classList.toggle('open');
        });
        document.addEventListener('click', e => {
          if (!menu.contains(e.target) && e.target !== pill) menu.classList.remove('open');
        });
      }
      if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
          signOut();
          window.location.href = 'index.html';
        });
      }
    }
  }

  function renderFooter() {
    const html = `
      <footer class="tarena-footer">
        <div class="row">
          <div>
            <div class="logo" style="font-size:1.6rem;margin-bottom:14px;">${logoSvg()} Trade<span>Arena</span></div>
            <p class="text-muted" style="max-width:340px;font-size:14px;line-height:1.6;">
              Paper trading platform for Australian university students. Real markets. Zero risk. Built in Sydney.
            </p>
          </div>
          <div style="text-align:right;">
            <p class="cinzel" style="font-size:12px;letter-spacing:2px;color:var(--gold);margin-bottom:8px;">© 2026 TradeArena · All warriors welcome</p>
            <a href="auth.html" class="text-muted" style="font-size:13px;">Already have an account? Sign in →</a>
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
    sendOtp, verifyOtp, getSession, signOut, requireAuth,
    isStudentEmail, getUniversity, getRegistrations,
    clearAllData, seedDemoUsers,
    getProfile, saveProfile,
  };
  global.TArenaUI = { renderNav, renderFooter, fmtMoney, fmtPct, logoSvg, getAvatar, avatarHtml };
})(window);
