// api/zerion.js — Vercel serverless function
// Proxies requests to api.zerion.io server-side (bypasses CORS)
// API key stored in Vercel environment variable ZERION_API_KEY

export default async function handler(req, res) {
  // CORS headers so the browser can call /api/zerion
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Pull Zerion key from Vercel env (set in dashboard, never exposed to browser)
  const ZERION_KEY = process.env.ZERION_API_KEY;
  if (!ZERION_KEY) {
    return res.status(500).json({ error: 'ZERION_API_KEY environment variable not set in Vercel dashboard.' });
  }

  // Forward the path + query string from the client to Zerion
  // Client calls: /api/zerion?path=/v1/wallets/0x.../positions/&filter[positions]=only_simple&...
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
    res.status(upstream.status)
       .setHeader('Content-Type', 'application/json')
       .end(body);
  } catch (err) {
    res.status(502).json({ error: 'Upstream fetch failed: ' + err.message });
  }
}
