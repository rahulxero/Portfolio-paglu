// api/lighter.js — Lighter perp DEX proxy
// Fetches margin balances + open positions for an EVM address on Lighter
// API docs: https://apidocs.lighter.xyz
// No API key required for read-only operations

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const BASE = 'https://mainnet.zklighter.elliot.ai/api/v1';
  const get = (path, ms = 8000) =>
    fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(ms) });

  try {
    // ── 1. Resolve EVM address → Lighter account indices ──────
    const byAddrRes = await get(`/accountsByL1Address?l1_address=${encodeURIComponent(address)}`);
    if (!byAddrRes.ok) return res.status(200).json({ positions: [] }); // no account = empty
    const byAddr = await byAddrRes.json();

    const subAccounts = byAddr.sub_accounts || [];
    if (!subAccounts.length) return res.status(200).json({ positions: [] });

    const positions = [];

    for (const sub of subAccounts) {
      const idx = sub.index;
      if (idx == null) continue;

      // ── 2. Fetch account details (margin balance + open positions) ──
      try {
        const accRes = await get(`/account?by=index&value=${idx}`);
        if (!accRes.ok) continue;
        const acc = await accRes.json();

        // Margin / collateral balance (USDC deposited as margin)
        const marginBalance = parseFloat(acc.margin || acc.margin_balance || 0);
        if (marginBalance > 0.01) {
          positions.push({
            symbol: 'USDC',
            name: 'Lighter Margin (USDC)',
            chain: 'lighter',
            balance: marginBalance,
            priceUSD: 1,
            valueUSD: marginBalance,
            ch24: null,
            source: 'lighter-margin',
          });
        }

        // Open perpetual positions
        const openPositions = acc.open_positions || acc.positions || [];
        for (const pos of openPositions) {
          const size = Math.abs(parseFloat(pos.size || pos.base_amount || 0));
          const markPrice = parseFloat(pos.mark_price || pos.oracle_price || 0);
          const notional = size * markPrice;
          if (notional < 0.01) continue;

          const symbol = (pos.market || pos.symbol || 'UNKNOWN').replace('/USDC', '').replace('-PERP', '').replace('-USD', '');
          const isLong = parseFloat(pos.size || pos.base_amount || 0) > 0;
          const entryPrice = parseFloat(pos.entry_price || 0);
          const unrealizedPnl = entryPrice > 0 ? (markPrice - entryPrice) * size * (isLong ? 1 : -1) : null;

          positions.push({
            symbol,
            name: `${symbol} ${isLong ? 'Long' : 'Short'} (Lighter)`,
            chain: 'lighter',
            balance: size,
            priceUSD: markPrice,
            valueUSD: notional,
            ch24: null,
            unrealizedPnl,
            isLong,
            source: 'lighter-perp',
          });
        }

        // ── 3. Fetch PnL summary (optional enrichment) ──
        try {
          const pnlRes = await get(`/pnl?account_index=${idx}&look_back=24h`, 5000);
          if (pnlRes.ok) {
            const pnl = await pnlRes.json();
            // Attach 24h PnL as a context marker if available
            const pnl24h = parseFloat(pnl.pnl_24h || pnl.realized_pnl || 0);
            if (pnl24h && positions.length) {
              positions[positions.length - 1].pnl24h = pnl24h;
            }
          }
        } catch (e) { /* pnl enrichment is best-effort */ }

      } catch (e) {
        console.warn(`Lighter account ${idx} fetch failed:`, e.message);
      }
    }

    positions.sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));
    return res.status(200).json({ positions });

  } catch (err) {
    console.error('Lighter proxy error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
