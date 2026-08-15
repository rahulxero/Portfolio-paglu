// api/admin.js — password-protected status page for API key configuration.
// Requires ADMIN_PASSWORD set in Vercel env vars.
//
// The session token deliberately contains NO secrets. It used to carry zerionKey
// and anthropicKey in its payload, which is base64url — an encoding, not encryption.
// Anyone holding the token could decode it and read both keys straight out of
// localStorage. Now it says only "this browser logged in, at this time".
//
// API keys live in Vercel env vars and are read server-side by the endpoints that
// need them. They are never sent to the browser, so there is nothing here to save.

const crypto = require('crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 hours

function sign(payload, secret) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

function verify(token, secret) {
  try {
    const [b64, sig] = (token || '').split('.');
    if (!b64 || !sig) return null;

    const expected = crypto.createHmac('sha256', secret).update(b64).digest('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return null;          // timingSafeEqual throws on length mismatch
    if (!crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());

    // The old version set iat and never looked at it, so a leaked token worked forever.
    if (!payload.iat || Date.now() - payload.iat > SESSION_TTL_MS) return null;

    return payload;
  } catch { return null; }
}

function safePasswordCheck(input, expected) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Crude in-memory rate limit. Serverless instances are short-lived and there may be
// several, so this is a speed bump rather than a wall — but it turns an unlimited
// online brute force into a slow one. A long ADMIN_PASSWORD is the real defence.
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, first: now };
  if (now - rec.first > 15 * 60 * 1000) { rec.count = 0; rec.first = now; }
  rec.count += 1;
  attempts.set(ip, rec);
  return rec.count > 10;
}

module.exports = async function handler(req, res) {
  // Only this site needs to call the admin API, so don't advertise it to every origin.
  const ORIGIN = process.env.SITE_ORIGIN || 'https://portfoliopaglu.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_PASS = process.env.ADMIN_PASSWORD;
  if (!ADMIN_PASS) return res.status(500).json({
    error: 'ADMIN_PASSWORD not set in Vercel env vars.'
  });

  const keyStatus = () => ({
    zerionKeySet:    !!process.env.ZERION_API_KEY,
    anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
  });

  // ── session check ──────────────────────────────────────
  if (req.method === 'GET') {
    const payload = verify(req.query.token || '', ADMIN_PASS);
    const ok = payload?.role === 'admin';
    // The browser can no longer read key status out of the token, so return it here.
    return res.status(ok ? 200 : 401).json(ok ? { ok, ...keyStatus() } : { ok: false });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  // ── login ──────────────────────────────────────────────
  if (body.action === 'login') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (tooManyAttempts(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
    }
    if (!body.password) return res.status(400).json({ error: 'Missing password' });
    if (!safePasswordCheck(body.password, ADMIN_PASS)) {
      return res.status(401).json({ error: 'Wrong password' });
    }

    const token = sign({ role: 'admin', iat: Date.now() }, ADMIN_PASS);
    const status = keyStatus();
    return res.status(200).json({
      ok: true, token, ...status,
      note: status.zerionKeySet && status.anthropicKeySet
        ? 'Keys loaded from Vercel env vars.'
        : 'Set the missing keys in Vercel → Settings → Environment Variables, then redeploy.',
    });
  }

  // ── save (removed) ─────────────────────────────────────
  // Saving keys meant round-tripping them through the browser inside the session
  // token. Env vars are the only place they belong.
  if (body.action === 'save') {
    return res.status(410).json({
      error: 'Keys are no longer set from this page. Add ZERION_API_KEY and ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables, then redeploy.',
    });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
