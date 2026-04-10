// api/stocks.js — Vercel serverless function
// Key priority: Vercel env var ANTHROPIC_API_KEY → x-anthropic-key request header

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-anthropic-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || req.headers['x-anthropic-key'];

  if (!ANTHROPIC_KEY) {
    return res.status(401).json({
      error: 'No Anthropic API key found. Add ANTHROPIC_API_KEY to Vercel env vars, or paste it in the app Settings.'
    });
  }

  const { indianSymbols = [], intlSymbols = [] } = req.body || {};
  if (!indianSymbols.length && !intlSymbols.length) {
    return res.status(400).json({ error: 'No symbols provided' });
  }

  const prompt = `Search for today's current stock prices. Return ONLY a JSON object, no markdown, no explanation.
Indian NSE stocks (return INR price): ${indianSymbols.join(', ')}
US/global stocks (return USD price): ${intlSymbols.join(', ')}
Also include current USD_INR exchange rate.
Example: {"RELIANCE":2680,"TCS":4120,"AAPL":192,"NVDA":875,"USD_INR":84}`;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'You are a financial data API. Respond ONLY with a raw JSON object. No markdown. No backticks. Just JSON.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return res.status(upstream.status).json({ error: err });
    }

    const data = await upstream.json();
    const txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    let prices = null;
    try { prices = JSON.parse(txt.trim()); } catch(e) {}
    if (!prices) { const m = txt.match(/\{[\s\S]*?\}/); if (m) try { prices = JSON.parse(m[0]); } catch(e) {} }
    if (!prices) { const m = txt.match(/```(?:json)?\s*([\s\S]*?)\s*```/); if (m) try { prices = JSON.parse(m[1]); } catch(e) {} }
    if (!prices) return res.status(500).json({ error: 'Failed to parse AI response', raw: txt.slice(0, 300) });

    return res.status(200).json(prices);
  } catch (err) {
    return res.status(502).json({ error: 'Upstream fetch failed: ' + err.message });
  }
}
