// api/zerion.js — Zerion API proxy (fixes CORS)
// The key comes from the ZERION_API_KEY env var and nowhere else. It is never
// sent to the browser and cannot be supplied by the caller.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ZERION_KEY = process.env.ZERION_API_KEY || null;

  if (!ZERION_KEY) {
    return res.status(401).json({
      error: 'Zerion API key not configured. Add ZERION_API_KEY in Vercel dashboard → Settings → Environment Variables.'
    });
  }

  const { path, ...rest } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path param' });

  // Must be a plain absolute path. This rejects @host tricks, protocol-relative
  // //host, backslashes, and anything else that could move the target off Zerion.
  if (typeof path !== 'string' || path.includes('..') ||
      !/^\/v1\/[A-Za-z0-9._~\/-]*$/.test(path)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const qs  = new URLSearchParams(rest).toString();
  const url = new URL(path + (qs ? '?' + qs : ''), 'https://api.zerion.io');

  // Belt and braces: whatever the regex let through, the request only goes to Zerion.
  if (url.origin !== 'https://api.zerion.io') {
    return res.status(400).json({ error: 'Invalid path' });
  }

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
};
