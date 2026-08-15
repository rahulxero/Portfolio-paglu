// api/user.js — Portfolio CRUD
// Uses Supabase REST API directly (no SDK) to avoid Node.js 20 WebSocket issues
// Auth: Firebase ID token

const { verifyIdToken } = require('./_auth');

// Direct Supabase REST call — no SDK needed
async function supaFetch(method, table, opts = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured');

  const { filter, body, select, upsert } = opts;
  let endpoint = `${url}/rest/v1/${table}`;

  const params = new URLSearchParams();
  if (select) params.set('select', select);
  if (filter) Object.entries(filter).forEach(([k, v]) => params.set(k, v));
  if (upsert) params.set('on_conflict', upsert);
  const qs = params.toString();
  if (qs) endpoint += '?' + qs;

  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? (upsert ? 'resolution=merge-duplicates,return=minimal' : 'return=representation') : 'return=representation',
  };

  const res = await fetch(endpoint, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch(e) { data = text; }

  if (!res.ok) {
    console.error(`Supabase ${method} ${table} error:`, res.status, text.slice(0, 300));
    throw Object.assign(new Error(data?.message || data?.error || `Supabase ${res.status}`), { code: data?.code, details: data?.details });
  }
  return data;
}

const EMPTY = { wallets:[], btc:[], others:[], indian:[], intl:[], mf:[], banks:[] };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyIdToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.SUPABASE_URL) {
    return res.status(200).json({ data: EMPTY, currency: 'INR', isNew: true });
  }

  const action = req.query.action || req.body?.action;

  try {
    // ── GET portfolio ──────────────────────────────────────
    if (req.method === 'GET' && action === 'portfolio') {
      const rows = await supaFetch('GET', 'portfolios', {
        select: 'data,currency,updated_at',
        filter: { 'user_id': `eq.${user.uid}`, 'limit': '1' },
      });
      if (!rows || !rows.length) return res.json({ data: EMPTY, currency: 'INR', isNew: true });
      return res.json(rows[0]);
    }

    // ── SAVE portfolio ─────────────────────────────────────
    if (req.method === 'POST' && action === 'portfolio') {
      const { data: portfolio, currency } = req.body;
      await supaFetch('POST', 'portfolios', {
        body: { user_id: user.uid, data: portfolio, currency: currency || 'INR', updated_at: new Date().toISOString() },
        upsert: 'user_id',
      });
      return res.json({ ok: true });
    }

    // ── SNAPSHOT ───────────────────────────────────────────
    if (req.method === 'POST' && action === 'snapshot') {
      const { value_usd, breakdown } = req.body;
      await supaFetch('POST', 'snapshots', {
        body: { user_id: user.uid, value_usd, breakdown, snapped_at: new Date().toISOString().slice(0,10) },
        upsert: 'user_id,snapped_at',
      });
      return res.json({ ok: true });
    }

    // ── GET snapshots ──────────────────────────────────────
    if (req.method === 'GET' && action === 'snapshots') {
      const days = parseInt(req.query.days || '90');
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
      const rows = await supaFetch('GET', 'snapshots', {
        select: 'value_usd,breakdown,snapped_at',
        filter: { 'user_id': `eq.${user.uid}`, 'snapped_at': `gte.${since}`, 'order': 'snapped_at.asc' },
      });
      return res.json({ snapshots: rows || [] });
    }

    // ── ALERTS ─────────────────────────────────────────────
    if (req.method === 'GET' && action === 'alerts') {
      const rows = await supaFetch('GET', 'alerts', {
        select: '*',
        filter: { 'user_id': `eq.${user.uid}`, 'order': 'created_at.desc' },
      });
      return res.json({ alerts: rows || [] });
    }

    if (req.method === 'POST' && action === 'alert_create') {
      const { type, asset, threshold, currency, channel, telegram_chat_id } = req.body;
      const rows = await supaFetch('POST', 'alerts', {
        body: { user_id: user.uid, type, asset, threshold, currency: currency||'USD', channel: channel||'email', telegram_chat_id },
      });
      return res.json({ alert: rows?.[0] });
    }

    if (req.method === 'DELETE' && action === 'alert_delete') {
      await supaFetch('DELETE', `alerts?id=eq.${req.body?.id}&user_id=eq.${user.uid}`, {});
      return res.json({ ok: true });
    }

    // ── SHARE LINKS ────────────────────────────────────────
    if (req.method === 'POST' && action === 'share_create') {
      const { slug, show_values } = req.body;
      const existing = await supaFetch('GET', 'share_links', { filter: { 'slug': `eq.${slug}`, 'limit': '1' } });
      if (existing?.length) return res.status(409).json({ error: 'Slug taken' });
      const rows = await supaFetch('POST', 'share_links', {
        body: { user_id: user.uid, slug, show_values: show_values !== false },
      });
      return res.json({ link: rows?.[0] });
    }

    if (req.method === 'GET' && action === 'share_get') {
      const rows = await supaFetch('GET', 'share_links', {
        filter: { 'user_id': `eq.${user.uid}`, 'limit': '1' },
      });
      return res.json({ link: rows?.[0] || null });
    }

    if (req.method === 'DELETE' && action === 'share_delete') {
      await supaFetch('DELETE', `share_links?user_id=eq.${user.uid}`, {});
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch(err) {
    console.error('user.js error:', err.message, err.code);
    return res.status(500).json({ error: err.message, code: err.code });
  }
};
