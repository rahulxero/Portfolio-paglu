// api/solana.js — Solana RPC proxy (bypasses CORS on free public RPCs)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const rpcs = [
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana-mainnet.g.alchemy.com/v2/demo',
    'https://mainnet.rpcpool.com',
  ];

  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'getBalance',
    params: [address],
  });

  for (const rpc of rpcs) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.error) continue;
      if (d.result?.value != null) {
        return res.status(200).json({ balance: d.result.value / 1e9 });
      }
    } catch(e) { continue; }
  }

  return res.status(503).json({ error: 'Solana RPC unavailable — try again later' });
};
