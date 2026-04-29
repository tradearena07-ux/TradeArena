// TradeArena — Supabase client singleton.
// Exposes the client as window.TArenaDB. Loaded after config.js and the
// Supabase UMD bundle (which puts its namespace on window.supabase).
(function () {
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('[TradeArena] Supabase SDK not loaded. Check the <script> order in this page.');
    return;
  }
  if (!window.TARENA_CONFIG || !window.TARENA_CONFIG.supabaseUrl) {
    console.error('[TradeArena] Missing Supabase config. Check assets/config.js.');
    return;
  }
  const { supabaseUrl, supabaseKey } = window.TARENA_CONFIG;
  window.TArenaDB = window.supabase.createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'tarena_sb_session',
    },
  });
})();
