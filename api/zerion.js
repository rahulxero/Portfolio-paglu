// api/zerion.js — Zerion API proxy (fixes CORS)
// Key priority: ZERION_API_KEY env var → x-session-token signed admin token

import crypto from 'crypto';

function keyFromToken(token, secret) {
  try {
    const [b64, sig] = (token || '').split('.');
    if (!b64 || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(b64).digest('hex');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    return payload?.role === 'admin' ? (payload.zerionKey || null) : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ZERION_KEY =
    process.env.ZERION_API_KEY ||
    (process.env.ADMIN_PASSWORD && keyFromToken(req.headers['x-session-token'], process.env.ADMIN_PASSWORD));

  if (!ZERION_KEY) return res.status(401).json({
    error: 'Zerion API key not configured. Visit /admin to set it up.'
  });

  const { path, ...rest } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path param' });

  const qs  = new URLSearchParams(rest).toString();
  const url = `https://api.zerion.io${path}${qs ? '?' + qs : ''}`;

  try {
    const r = await fetch(url, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(ZERION_KEY + ':').toString('base64'),
        Accept: 'application/json',
      },
    });
    const body = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json').end(body);
  } catch (err) {
    res.status(502).json({ error: 'Upstream error: ' + err.message });
  }
}
