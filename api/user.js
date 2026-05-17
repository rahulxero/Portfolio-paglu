// api/user.js — Portfolio CRUD
// Auth: Firebase ID token | Storage: Supabase service key

const { createClient } = require('@supabase/supabase-js');

function decodeToken(authHeader) {
  try {
    const token = (authHeader || '').replace('Bearer ', '').trim();
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const p = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (p.exp && p.exp * 1000 < Date.now()) { console.log('Token expired'); return null; }
    const uid = p.user_id || p.sub;
    if (!uid) { console.log('No uid in token, keys:', Object.keys(p)); return null; }
    console.log('Auth OK uid:', uid, 'aud:', p.aud, 'project:', process.env.FIREBASE_PROJECT_ID);
    return { uid, email: p.email };
  } catch(e) { console.error('Token decode error:', e.message); return null; }
}

function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.log('Supabase env vars missing'); return null; }
  return createClient(url, key, { auth: { persistSession: false } });
}

const EMPTY = { wallets:[], btc:[], others:[], indian:[], intl:[], mf:[], banks:[] };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = decodeToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const client = sb();
  if (!client) return res.status(200).json({ data: EMPTY, currency: 'INR', isNew: true, _note: 'no db' });

  const action = req.query.action || req.body?.action;

  try {
    // ── GET portfolio ──────────────────────────────────────
    if (req.method === 'GET' && action === 'portfolio') {
      const { data, error } = await client
        .from('portfolios').select('data,currency,updated_at')
        .eq('user_id', user.uid).maybeSingle();
      if (error) { console.error('GET portfolio error:', error); throw error; }
      if (!data) return res.json({ data: EMPTY, currency: 'INR', isNew: true });
      return res.json(data);
    }

    // ── SAVE portfolio ─────────────────────────────────────
    if (req.method === 'POST' && action === 'portfolio') {
      const { data: portfolio, currency } = req.body;
      const { error } = await client.from('portfolios').upsert(
        { user_id: user.uid, data: portfolio, currency: currency || 'INR', updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (error) { console.error('SAVE portfolio error:', error); throw error; }
      return res.json({ ok: true });
    }

    // ── SNAPSHOT ───────────────────────────────────────────
    if (req.method === 'POST' && action === 'snapshot') {
      const { value_usd, breakdown } = req.body;
      const { error } = await client.from('snapshots').upsert(
        { user_id: user.uid, value_usd, breakdown, snapped_at: new Date().toISOString().slice(0,10) },
        { onConflict: 'user_id,snapped_at' }
      );
      if (error) { console.error('Snapshot error:', error); throw error; }
      return res.json({ ok: true });
    }

    // ── GET snapshots ──────────────────────────────────────
    if (req.method === 'GET' && action === 'snapshots') {
      const days = parseInt(req.query.days || '90');
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
      const { data, error } = await client.from('snapshots')
        .select('value_usd,breakdown,snapped_at')
        .eq('user_id', user.uid).gte('snapped_at', since)
        .order('snapped_at', { ascending: true });
      if (error) throw error;
      return res.json({ snapshots: data || [] });
    }

    // ── ALERTS ─────────────────────────────────────────────
    if (req.method === 'GET' && action === 'alerts') {
      const { data, error } = await client.from('alerts').select('*')
        .eq('user_id', user.uid).order('created_at', { ascending: false });
      if (error) throw error;
      return res.json({ alerts: data || [] });
    }

    if (req.method === 'POST' && action === 'alert_create') {
      const { type, asset, threshold, currency, channel, telegram_chat_id } = req.body;
      const { data, error } = await client.from('alerts').insert(
        { user_id: user.uid, type, asset, threshold, currency: currency||'USD', channel: channel||'email', telegram_chat_id }
      ).select().single();
      if (error) throw error;
      return res.json({ alert: data });
    }

    if (req.method === 'DELETE' && action === 'alert_delete') {
      const { error } = await client.from('alerts').delete().eq('id', req.body?.id).eq('user_id', user.uid);
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (req.method === 'POST' && action === 'alert_toggle') {
      const { error } = await client.from('alerts').update({ active: req.body?.active }).eq('id', req.body?.id).eq('user_id', user.uid);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // ── SHARE LINKS ────────────────────────────────────────
    if (req.method === 'POST' && action === 'share_create') {
      const { slug, show_values } = req.body;
      const { data: ex } = await client.from('share_links').select('id').eq('slug', slug).maybeSingle();
      if (ex) return res.status(409).json({ error: 'Slug taken' });
      const { data, error } = await client.from('share_links')
        .insert({ user_id: user.uid, slug, show_values: show_values !== false }).select().single();
      if (error) throw error;
      return res.json({ link: data });
    }

    if (req.method === 'GET' && action === 'share_get') {
      const { data, error } = await client.from('share_links').select('*').eq('user_id', user.uid).maybeSingle();
      if (error) throw error;
      return res.json({ link: data || null });
    }

    if (req.method === 'DELETE' && action === 'share_delete') {
      await client.from('share_links').delete().eq('user_id', user.uid);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch(err) {
    console.error('user.js handler error:', err?.message, err?.code, err?.details);
    return res.status(500).json({ error: err?.message || 'Server error', code: err?.code, details: err?.details });
  }
};
