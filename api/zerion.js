// api/zerion.js — Vercel serverless function
// Key priority: Vercel env var ZERION_API_KEY → x-zerion-key request header (from browser localStorage)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-zerion-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Accept key from env var OR from request header (user pasted it in app settings)
  const ZERION_KEY = process.env.ZERION_API_KEY || req.headers['x-zerion-key'];

  if (!ZERION_KEY) {
    return res.status(401).json({
      error: 'No Zerion API key found. Add ZERION_API_KEY to Vercel env vars, or paste it in the app Settings.'
    });
  }

  const { path, ...rest } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path query param' });

  const qs = new URLSearchParams(rest).toString();
  const zerionUrl = `https://api.zerion.io${path}${qs ? '?' + qs : ''}`;

  try {
    const upstream = await fetch(zerionUrl, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(ZERION_KEY + ':').toString('base64'),
        Accept: 'application/json',
      },
    });
    const body = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json').end(body);
  } catch (err) {
    res.status(502).json({ error: 'Upstream fetch failed: ' + err.message });
  }
}
