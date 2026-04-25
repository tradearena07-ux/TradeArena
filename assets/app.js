// TradeArena — shared client logic
// Demo-mode auth using localStorage (works fully offline / on a static host).
(function (global) {
  const SESSION_KEY = 'tarena_session';
  const PENDING_KEY = 'tarena_pending_otp';
  const REGS_KEY    = 'tarena_registrations';

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

  // sendOtp(email, type) → { ok, code, expiresAt, error }
  function sendOtp(email, type) {
    email = (email || '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'Please enter your email address.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: 'That doesn\'t look like a valid email address.' };
    }
    if (type === 'student' && !isStudentEmail(email)) {
      return { ok: false, error: 'Please use a university email (.edu.au) or switch to Public access.' };
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
    if (String(code) !== p.code)  return { ok: false, error: 'Incorrect code. Please try again.' };

    const session = {
      user: {
        email:      p.email,
        handle:     '@' + p.email.split('@')[0].replace(/\./g, '_'),
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

  function signOut() {
    clearSession();
  }

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
    [SESSION_KEY, PENDING_KEY, REGS_KEY, 'tarena_orders', 'tarena_watchlist'].forEach(k => localStorage.removeItem(k));
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
      { id: 'leagues',   href: '#leagues',       label: 'Leagues' },
      { id: 'campus',    href: '#campus',        label: 'Campus' },
    ];
    const session = getSession();
    const linksHtml = links.map(l =>
      `<a href="${l.href}" class="${activePage === l.id ? 'active' : ''}">${l.label}</a>`
    ).join('');

    let accountHtml;
    if (session) {
      accountHtml = `
        <div class="user-pill" id="userPill" title="Click to sign out">
          <span class="dot"></span>
          <span>${session.user.handle}</span>
          <span class="text-muted" style="font-size:11px;">· ${session.user.university}</span>
        </div>`;
    } else {
      accountHtml = `<a href="auth.html" class="btn-account ${activePage === 'auth' ? 'active' : ''}">Account</a>`;
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
      if (pill) pill.addEventListener('click', () => {
        if (confirm('Sign out of TradeArena?')) {
          signOut();
          window.location.href = 'index.html';
        }
      });
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
  };
  global.TArenaUI = { renderNav, renderFooter, fmtMoney, fmtPct, logoSvg };
})(window);
