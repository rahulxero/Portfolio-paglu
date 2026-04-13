// api/user.js — Supabase portfolio CRUD + snapshots + alerts + share links
// All operations require a valid Supabase JWT in Authorization header

const { createClient } = require('@supabase/supabase-js');

function getSupabase(authHeader) {
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  // Use the user's JWT so RLS policies apply
  const token = authHeader?.replace('Bearer ', '');
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL) {
    return res.status(500).json({ error: 'SUPABASE_URL not set in Vercel env vars' });
  }

  const sb = getSupabase(req.headers.authorization);
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' });

  // Get authenticated user
  const { data: { user }, error: authErr } = await sb.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Not authenticated' });

  const action = req.query.action || req.body?.action;

  try {
    // ── GET PORTFOLIO ──────────────────────────────────────
    if (req.method === 'GET' && action === 'portfolio') {
      const { data, error } = await sb
        .from('portfolios')
        .select('data, currency, updated_at')
        .eq('user_id', user.id)
        .single();

      if (error && error.code === 'PGRST116') {
        // No portfolio yet — return empty
        return res.status(200).json({
          data: { wallets:[], btc:[], others:[], indian:[], intl:[], mf:[], banks:[] },
          currency: 'INR',
          updated_at: null,
          isNew: true,
        });
      }
      if (error) throw error;
      return res.status(200).json(data);
    }

    // ── SAVE PORTFOLIO ────────────────────────────────────
    if (req.method === 'POST' && action === 'portfolio') {
      const { data: portfolio, currency } = req.body;
      const { error } = await sb
        .from('portfolios')
        .upsert({ user_id: user.id, data: portfolio, currency }, { onConflict: 'user_id' });
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    // ── SAVE SNAPSHOT (daily) ─────────────────────────────
    if (req.method === 'POST' && action === 'snapshot') {
      const { value_usd, breakdown } = req.body;
      const { error } = await sb
        .from('snapshots')
        .upsert(
          { user_id: user.id, value_usd, breakdown, snapped_at: new Date().toISOString().slice(0,10) },
          { onConflict: 'user_id,snapped_at' }
        );
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    // ── GET SNAPSHOTS (for history chart) ─────────────────
    if (req.method === 'GET' && action === 'snapshots') {
      const days = parseInt(req.query.days || '90');
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
      const { data, error } = await sb
        .from('snapshots')
        .select('value_usd, breakdown, snapped_at')
        .eq('user_id', user.id)
        .gte('snapped_at', since)
        .order('snapped_at', { ascending: true });
      if (error) throw error;
      return res.status(200).json({ snapshots: data || [] });
    }

    // ── ALERTS CRUD ───────────────────────────────────────
    if (req.method === 'GET' && action === 'alerts') {
      const { data, error } = await sb
        .from('alerts')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ alerts: data || [] });
    }

    if (req.method === 'POST' && action === 'alert_create') {
      const { type, asset, threshold, currency, channel, telegram_chat_id } = req.body;
      const { data, error } = await sb
        .from('alerts')
        .insert({ user_id: user.id, type, asset, threshold, currency: currency||'USD', channel: channel||'email', telegram_chat_id })
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json({ alert: data });
    }

    if (req.method === 'DELETE' && action === 'alert_delete') {
      const { id } = req.body;
      const { error } = await sb.from('alerts').delete().eq('id', id).eq('user_id', user.id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'alert_toggle') {
      const { id, active } = req.body;
      const { error } = await sb.from('alerts').update({ active }).eq('id', id).eq('user_id', user.id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    // ── SHARE LINKS ───────────────────────────────────────
    if (req.method === 'POST' && action === 'share_create') {
      const { slug, show_values } = req.body;
      // Check slug not taken
      const { data: existing } = await sb.from('share_links').select('id').eq('slug', slug).single();
      if (existing) return res.status(409).json({ error: 'Slug already taken' });
      const { data, error } = await sb
        .from('share_links')
        .insert({ user_id: user.id, slug, show_values: show_values !== false })
        .select().single();
      if (error) throw error;
      return res.status(200).json({ link: data });
    }

    if (req.method === 'GET' && action === 'share_get') {
      const { data, error } = await sb
        .from('share_links')
        .select('*')
        .eq('user_id', user.id)
        .single();
      if (error && error.code === 'PGRST116') return res.status(200).json({ link: null });
      if (error) throw error;
      return res.status(200).json({ link: data });
    }

    if (req.method === 'DELETE' && action === 'share_delete') {
      await sb.from('share_links').delete().eq('user_id', user.id);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('user.js error:', err);
    return res.status(500).json({ error: err.message });
  }
};
