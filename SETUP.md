# TradeArena — Supabase Setup Guide

Complete step-by-step instructions to wire up auth, database, and email for tradearena.com.au.

---

## 1. Create Your Supabase Project

1. Go to [https://supabase.com](https://supabase.com) → **Start your project** (free tier is fine)
2. Create a new organisation: `TradeArena`
3. Create a new project: `tradearena-prod`
4. Choose region: **ap-southeast-2** (Sydney — closest to your users)
5. Set a strong database password and save it somewhere safe

---

## 2. Get Your API Keys

1. In your Supabase dashboard → **Project Settings** → **API**
2. Copy these two values — you'll need them in all 3 HTML files:
   - **Project URL** (looks like `https://xxxxxxxxxxxx.supabase.co`)
   - **anon / public key** (long JWT string)

3. In each file (`auth.html`, `trade.html`, `admin.html`), replace:
   ```js
   const SUPABASE_URL = 'YOUR_SUPABASE_URL';
   const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
   ```
   with your actual values.

---

## 3. Run the Database Schema

Go to **SQL Editor** in your Supabase dashboard and run this entire block:

```sql
-- ─────────────────────────────────────────────────────────────────
-- TradeArena Database Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ─────────────────────────────────────────────────────────────────

-- 1. REGISTRATIONS
-- Stores user profile + university info
CREATE TABLE IF NOT EXISTS registrations (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  university  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(email),
  UNIQUE(user_id)
);

-- 2. PORTFOLIOS
-- One per user, starts with $10,000 paper money
CREATE TABLE IF NOT EXISTS portfolios (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  cash_balance  NUMERIC(12,2) DEFAULT 10000.00,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- 3. HOLDINGS
-- Current positions for each user
CREATE TABLE IF NOT EXISTS holdings (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  shares      NUMERIC(18,8) NOT NULL DEFAULT 0,
  avg_price   NUMERIC(12,4) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, symbol)
);

-- 4. TRADES
-- Full trade history
CREATE TABLE IF NOT EXISTS trades (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('buy', 'sell')),
  shares      NUMERIC(18,8) NOT NULL,
  price       NUMERIC(12,4) NOT NULL,
  total       NUMERIC(12,2) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- Users can only see and edit their own data
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolios    ENABLE ROW LEVEL SECURITY;
ALTER TABLE holdings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades        ENABLE ROW LEVEL SECURITY;

-- Registrations: users can read/write their own row
CREATE POLICY "Users can manage own registration"
  ON registrations FOR ALL
  USING (auth.uid() = user_id);

-- Allow insert without user_id (for pre-auth waitlist signups)
CREATE POLICY "Allow public insert to registrations"
  ON registrations FOR INSERT
  WITH CHECK (true);

-- Portfolios: users can read/write their own
CREATE POLICY "Users can manage own portfolio"
  ON portfolios FOR ALL
  USING (auth.uid() = user_id);

-- Holdings: users can read/write their own
CREATE POLICY "Users can manage own holdings"
  ON holdings FOR ALL
  USING (auth.uid() = user_id);

-- Trades: users can read/write their own
CREATE POLICY "Users can manage own trades"
  ON trades FOR ALL
  USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────
-- ADMIN POLICY (for admin.html to read all data)
-- Replace 'tradearena07@gmail.com' with your actual admin email(s)
-- ─────────────────────────────────────────────────────────────────

-- Allow admin to read all registrations
CREATE POLICY "Admin reads all registrations"
  ON registrations FOR SELECT
  USING (
    (SELECT email FROM auth.users WHERE id = auth.uid())
    IN ('tradearena07@gmail.com')
  );

-- Allow admin to read all portfolios
CREATE POLICY "Admin reads all portfolios"
  ON portfolios FOR SELECT
  USING (
    (SELECT email FROM auth.users WHERE id = auth.uid())
    IN ('tradearena07@gmail.com')
  );

-- Allow admin to read all trades
CREATE POLICY "Admin reads all trades"
  ON trades FOR SELECT
  USING (
    (SELECT email FROM auth.users WHERE id = auth.uid())
    IN ('tradearena07@gmail.com')
  );

-- ─────────────────────────────────────────────────────────────────
-- INDEXES for performance
-- ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_registrations_email    ON registrations(email);
CREATE INDEX IF NOT EXISTS idx_registrations_user_id  ON registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_user_id     ON portfolios(user_id);
CREATE INDEX IF NOT EXISTS idx_holdings_user_id       ON holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_user_id         ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_created_at      ON trades(created_at DESC);
```

---

## 4. Configure Auth Settings

In Supabase Dashboard → **Authentication** → **Settings**:

### Site URL
```
https://www.tradearena.com.au
```

### Redirect URLs (add all of these)
```
https://www.tradearena.com.au/auth.html
https://tradearena.com.au/auth.html
http://localhost:3000/auth.html
http://127.0.0.1:5500/auth.html
```

### Email Templates
Go to **Authentication** → **Email Templates** → **Magic Link**

Replace the body with:

```html
<div style="font-family: 'Georgia', serif; max-width: 480px; margin: 0 auto; background: #060e1c; color: #f2e8cc; padding: 48px 40px; border: 1px solid rgba(201,160,48,0.3);">
  <div style="font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: #c9a030; margin-bottom: 32px;">
    TradeArena · Sydney Beta
  </div>
  <h1 style="font-size: 1.8rem; font-weight: 600; line-height: 1.2; margin-bottom: 16px;">
    Your arena awaits.
  </h1>
  <p style="font-size: 0.9rem; color: #7a8aaa; line-height: 1.8; margin-bottom: 36px;">
    Click the button below to sign in to TradeArena. This link expires in 10 minutes.
  </p>
  <a href="{{ .ConfirmationURL }}"
     style="display: inline-block; background: #c9a030; color: #060e1c; padding: 14px 36px;
            font-size: 12px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
            text-decoration: none; font-family: Georgia, serif;">
    Enter the Arena →
  </a>
  <p style="margin-top: 36px; font-size: 11px; color: #7a8aaa; line-height: 1.7;">
    If you didn't request this, you can safely ignore this email.<br>
    © 2025 TradeArena Pty Ltd · Sydney, Australia
  </p>
</div>
```

---

## 5. Configure Vercel Environment Variables

In your Vercel project dashboard → **Settings** → **Environment Variables**, add:

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJ...` |

> **Note:** Since your site is static HTML (not Next.js), you don't actually need Vercel env vars — the keys are inline in the HTML files. Just make sure you've replaced the placeholder strings.

---

## 6. Update the Landing Page (index.html)

In your existing `TradeArena.html` / `index.html`, update the email form button to redirect to `auth.html` instead of submitting locally.

Find the `handleJoin()` function and replace it with:

```js
function handleJoin() {
  const email = document.getElementById('email-in').value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('email-in').style.borderLeft = '2px solid #f87171';
    return;
  }
  // Redirect to auth page with email pre-filled
  window.location.href = `auth.html?email=${encodeURIComponent(email)}`;
}
```

And in `auth.html`, add this to the `DOMContentLoaded` handler to pre-fill the email:

```js
// Pre-fill email from landing page redirect
const params = new URLSearchParams(window.location.search);
const prefill = params.get('email');
if (prefill) document.getElementById('emailInput').value = prefill;
```

---

## 7. Admin Access

Access the admin dashboard at:
```
https://www.tradearena.com.au/admin.html
```

Only emails listed in the `ADMIN_EMAILS` array in `admin.html` can access it.
Add more admins by editing:
```js
const ADMIN_EMAILS = ['tradearena07@gmail.com', 'another@email.com'];
```
And updating the SQL policies accordingly.

---

## 8. File Structure for GitHub

Your repo should look like:
```
/
├── index.html          ← Landing page (TradeArena.html renamed)
├── auth.html           ← Login / magic link
├── trade.html          ← Paper trading dashboard  
├── admin.html          ← Admin command center
└── SETUP.md            ← This file
```

Push to GitHub → Vercel auto-deploys. Done.

---

## 9. Verify Everything Works

Test checklist:
- [ ] Visit `tradearena.com.au` — landing page loads
- [ ] Click "Enter the Arena" → redirects to `auth.html`
- [ ] Enter a `.edu.au` email → magic link email arrives
- [ ] Click magic link → redirected to `trade.html`
- [ ] Place a paper trade → appears in Trade History
- [ ] Visit `tradearena.com.au/admin.html` with your admin email → shows registrations
- [ ] Non-admin email → access denied

---

## Support

Questions: tradearena07@gmail.com
Supabase docs: https://supabase.com/docs
