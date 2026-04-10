// api/admin.js — password-protected key management
// Requires ADMIN_PASSWORD set in Vercel env vars
// POST { action:'login', password }  → { ok, token, note }
// POST { action:'save', token, zerionKey?, anthropicKey? } → { ok, token }
// GET  ?action=check&token=…         → { ok }

import crypto from 'crypto';

// ── token helpers ─────────────────────────────────────────
function sign(payload, secret) {
  const data = JSON.stringify(payload);
  const b64  = Buffer.from(data).toString('base64url');
  const sig  = crypto.createHmac('sha256', secret).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

function verify(token, secret) {
  try {
    const [b64, sig] = (token || '').split('.');
    if (!b64 || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(b64).digest('hex');
    // Pad both to same length before timingSafeEqual
    const a = Buffer.from(sig.padEnd(64, '0'));
    const b = Buffer.from(expected.padEnd(64, '0'));
    if (!crypto.timingSafeEqual(a, b)) return null;
    if (sig !== expected) return null; // double-check after timing-safe comparison
    return JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch { return null; }
}

function safePasswordCheck(input, expected) {
  // Hash both so they're always the same length
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ADMIN_PASS = process.env.ADMIN_PASSWORD;
  if (!ADMIN_PASS) return res.status(500).json({
    error: 'ADMIN_PASSWORD not set in Vercel env vars. Go to Vercel → your project → Settings → Environment Variables and add it.'
  });

  // GET: verify token validity
  if (req.method === 'GET') {
    const { token } = req.query;
    const payload = verify(token || '', ADMIN_PASS);
    return res.status(payload?.role === 'admin' ? 200 : 401).json({ ok: payload?.role === 'admin' });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  // LOGIN
  if (body.action === 'login') {
    if (!body.password) return res.status(400).json({ error: 'Missing password' });
    if (!safePasswordCheck(body.password, ADMIN_PASS)) {
      return res.status(401).json({ error: 'Wrong password' });
    }
    const zerionKey    = process.env.ZERION_API_KEY    || '';
    const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
    const token = sign({ role:'admin', zerionKey, anthropicKey, iat: Date.now() }, ADMIN_PASS);
    return res.status(200).json({
      ok: true, token,
      zerionKeySet:    !!zerionKey,
      anthropicKeySet: !!anthropicKey,
      note: zerionKey
        ? 'Keys loaded from Vercel environment variables.'
        : 'No keys set in Vercel env yet — paste them below to activate live data.',
    });
  }

  // SAVE KEYS
  if (body.action === 'save') {
    const payload = verify(body.token || '', ADMIN_PASS);
    if (payload?.role !== 'admin') return res.status(401).json({ error: 'Invalid or expired session' });

    const zerionKey    = (body.zerionKey    || '').trim() || payload.zerionKey    || process.env.ZERION_API_KEY    || '';
    const anthropicKey = (body.anthropicKey || '').trim() || payload.anthropicKey || process.env.ANTHROPIC_API_KEY || '';
    const token = sign({ role:'admin', zerionKey, anthropicKey, iat: Date.now() }, ADMIN_PASS);
    return res.status(200).json({ ok: true, token, zerionKeySet: !!zerionKey, anthropicKeySet: !!anthropicKey });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
