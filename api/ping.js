// api/ping.js — keeps Supabase from going dormant
// Called by the app every 3 days + by external cron services
// Also useful as a health check endpoint

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const start = Date.now();
  const result = { ok: true, ts: new Date().toISOString(), latency: null, supabase: null };

  // Ping Supabase with a lightweight query
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (url && key) {
      // Cheapest possible query — just check the DB is alive
      const r = await fetch(`${url}/rest/v1/portfolios?select=user_id&limit=1`, {
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
        },
        signal: AbortSignal.timeout(8000),
      });
      result.supabase = r.ok ? 'ok' : `error_${r.status}`;
    } else {
      result.supabase = 'not_configured';
    }
  } catch(e) {
    result.supabase = `error: ${e.message}`;
  }

  result.latency = Date.now() - start;
  return res.status(200).json(result);
};
