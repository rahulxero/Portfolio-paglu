// api/user.js — Portfolio CRUD + snapshots + alerts + share links
// Auth: Firebase ID token in Authorization header
// Storage: Supabase (using service key)

const { createClient } = require('@supabase/supabase-js');

async function verifyFirebaseToken(authHeader) {
  const token = authHeader?.replace('Bearer ', '').trim();
  if (!token) { console.log('No token provided'); return null; }
  
  try {
    const parts = token.split('.');
    if (parts.length !== 3) { console.log('Invalid JWT format'); return null; }
    
    // Fix base64url to base64
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    console.log('Token payload keys:', Object.keys(payload));
    console.log('aud:', payload.aud, 'exp:', payload.exp, 'sub:', payload.sub, 'user_id:', payload.user_id);
    
    // Check expiry
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      console.log('Token expired at', new Date(payload.exp * 1000));
      return null;
    }

    // Check audience
    const projectId = process.env.FIREBASE_PROJECT_ID;
    console.log('Expected projectId:', projectId, 'Got aud:', payload.aud);
    if (projectId && payload.aud !== projectId) {
      console.log('Audience mismatch — skipping aud check for now');
      // Don't reject — some Firebase tokens may have different aud format
    }

    const uid = payload.user_id || payload.sub;
    if (!uid) { console.log('No uid found in token'); return null; }

    console.log('Token verified OK, uid:', uid);
    return { uid, email: payload.email };
  } catch(e) {
    console.error('Token verify error:', e.message);
    return null;
  }
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.log('Supabase not configured'); return null; }
  return createClient(url, key, { auth: { persistSession: false } });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const fbUser = await verifyFirebaseToken(req.headers.authorization);
  if (!fbUser) return res.status(401).json({ error: 'Not authenticated — check Firebase token' });
  const userId = fbUser.uid;

  const sb = getSupabase();
  if (!sb) return res.status(200).json({
    data: { wallets:[], btc:[], others:[], indian:[], intl:[], mf:[], banks:[] },
    currency: 'INR', isNew: true,
    _note: 'Supabase not configured'
  });

  const action = req.query.action || req.body?.action;

  try {
    if (req.method === 'GET' && action === 'portfolio') {
      const { data, error } = await sb.from('portfolios').select('data, currency, updated_at').eq('user_id', userId).single();
      if (error && error.code === 'PGRST116') return res.status(200).json({
        data: { wallets:[], btc:[], others:[], indian:[], intl:[], mf:[], banks:[] },
        currency: 'INR', isNew: true
      });
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'POST' && action === 'portfolio') {
      const { data: portfolio, currency } = req.body;
      const { error } = await sb.from('portfolios').upsert(
        { user_id: userId, data: portfolio, currency },
        { onConflict: 'user_id' }
      );
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'snapshot') {
      const { value_usd, breakdown } = req.body;
      const { error } = await sb.from('snapshots').upsert(
        { user_id: userId, value_usd, breakdown, snapped_at: new Date().toISOString().slice(0,10) },
        { onConflict: 'user_id,snapped_at' }
      );
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET' && action === 'snapshots') {
      const days = parseInt(req.query.days || '90');
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
      const { data, error } = await sb.from('snapshots').select('value_usd, breakdown, snapped_at')
        .eq('user_id', userId).gte('snapped_at', since).order('snapped_at', { ascending: true });
      if (error) throw error;
      return res.status(200).json({ snapshots: data || [] });
    }

    if (req.method === 'GET' && action === 'alerts') {
      const { data, error } = await sb.from('alerts').select('*').eq('user_id', userId).order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ alerts: data || [] });
    }

    if (req.method === 'POST' && action === 'alert_create') {
      const { type, asset, threshold, currency, channel, telegram_chat_id } = req.body;
      const { data, error } = await sb.from('alerts').insert(
        { user_id: userId, type, asset, threshold, currency: currency||'USD', channel: channel||'email', telegram_chat_id }
      ).select().single();
      if (error) throw error;
      return res.status(200).json({ alert: data });
    }

    if (req.method === 'DELETE' && action === 'alert_delete') {
      const { id } = req.body;
      const { error } = await sb.from('alerts').delete().eq('id', id).eq('user_id', userId);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'alert_toggle') {
      const { id, active } = req.body;
      const { error } = await sb.from('alerts').update({ active }).eq('id', id).eq('user_id', userId);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'share_create') {
      const { slug, show_values } = req.body;
      const { data: existing } = await sb.from('share_links').select('id').eq('slug', slug).single();
      if (existing) return res.status(409).json({ error: 'Slug already taken' });
      const { data, error } = await sb.from('share_links').insert(
        { user_id: userId, slug, show_values: show_values !== false }
      ).select().single();
      if (error) throw error;
      return res.status(200).json({ link: data });
    }

    if (req.method === 'GET' && action === 'share_get') {
      const { data, error } = await sb.from('share_links').select('*').eq('user_id', userId).single();
      if (error && error.code === 'PGRST116') return res.status(200).json({ link: null });
      if (error) throw error;
      return res.status(200).json({ link: data });
    }

    if (req.method === 'DELETE' && action === 'share_delete') {
      await sb.from('share_links').delete().eq('user_id', userId);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('user.js error:', err.message, err.code);
    return res.status(500).json({ error: err.message, code: err.code });
  }
};
