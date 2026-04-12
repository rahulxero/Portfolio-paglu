// api/stocks.js — Anthropic AI stock price proxy (CORS fix)
// Key priority: ANTHROPIC_API_KEY env var → x-session-token signed admin token

const crypto = require('crypto');

function keyFromToken(token, secret) {
  try {
    const [b64, sig] = (token || '').split('.');
    if (!b64 || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(b64).digest('hex');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    return payload?.role === 'admin' ? (payload.anthropicKey || null) : null;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const ANTHROPIC_KEY =
    process.env.ANTHROPIC_API_KEY ||
    (process.env.ADMIN_PASSWORD && keyFromToken(req.headers['x-session-token'], process.env.ADMIN_PASSWORD));

  if (!ANTHROPIC_KEY) return res.status(401).json({
    error: 'Anthropic API key not configured. Visit /admin to set it up.'
  });

  const { indianSymbols = [], intlSymbols = [] } = req.body || {};
  if (!indianSymbols.length && !intlSymbols.length) return res.status(400).json({ error: 'No symbols' });

  const prompt = `Search for today's current stock prices. Return ONLY a JSON object, no markdown.
Indian NSE stocks (INR price): ${indianSymbols.join(', ')}
US stocks (USD price): ${intlSymbols.join(', ')}
Include USD_INR exchange rate.
Example: {"RELIANCE":2680,"TCS":4120,"AAPL":192,"NVDA":875,"USD_INR":84}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 600,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'You are a financial data API. Respond ONLY with a raw JSON object. No markdown. No backticks.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: e }); }

    const data = await r.json();
    const txt  = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let prices = null;
    try { prices = JSON.parse(txt.trim()); } catch {}
    if (!prices) { const m = txt.match(/\{[\s\S]*?\}/); if (m) try { prices = JSON.parse(m[0]); } catch {} }
    if (!prices) return res.status(500).json({ error: 'Could not parse AI response', raw: txt.slice(0, 200) });

    return res.status(200).json(prices);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
};
