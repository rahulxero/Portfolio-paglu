// api/polymarket.js — Polymarket positions proxy
// Uses the public Data API (no auth required)
// Docs: https://docs.polymarket.com/api-reference/core

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const DATA_API = 'https://data-api.polymarket.com';
  const positions = [];

  try {
    // ── 1. Fetch open positions ───────────────────────────
    const posRes = await fetch(
      `${DATA_API}/positions?user=${address}&sizeThreshold=0.01&limit=100`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (posRes.ok) {
      const posData = await posRes.json();
      const openPositions = Array.isArray(posData) ? posData : [];

      for (const p of openPositions) {
        const currentValue = parseFloat(p.currentValue || 0);
        const size = parseFloat(p.size || 0);
        if (currentValue < 0.01 && size < 0.01) continue;

        const curPrice = parseFloat(p.curPrice || 0);
        const avgPrice = parseFloat(p.avgPrice || 0);
        const initialValue = parseFloat(p.initialValue || 0);
        const cashPnl = parseFloat(p.cashPnl || 0);
        const percentPnl = parseFloat(p.percentPnl || 0);

        positions.push({
          id: `poly-${p.conditionId || p.asset}`,
          title: p.title || 'Unknown Market',
          outcome: p.outcome || '',
          slug: p.slug || '',
          icon: p.icon || '',
          eventSlug: p.eventSlug || '',

          // Position details
          size,           // number of shares
          curPrice,       // current price (0-1, probability)
          avgPrice,       // avg buy price
          currentValue,   // current value in USDC
          initialValue,   // amount invested in USDC
          cashPnl,        // unrealized P&L in USDC
          percentPnl,     // unrealized P&L %

          // For display
          valueUSD: currentValue,
          priceUSD: curPrice,
          symbol: 'POLY',
          chain: 'polymarket',
          source: 'polymarket',
          redeemable: p.redeemable || false,
        });
      }
    }

    // ── 2. Fetch total portfolio value ────────────────────
    let totalValue = positions.reduce((s, p) => s + p.currentValue, 0);
    try {
      const valRes = await fetch(
        `${DATA_API}/value?user=${address}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (valRes.ok) {
        const valData = await valRes.json();
        const apiTotal = parseFloat(valData?.[0]?.value || valData?.value || 0);
        if (apiTotal > 0) totalValue = apiTotal;
      }
    } catch(e) {}

    // Sort by value descending
    positions.sort((a, b) => b.currentValue - a.currentValue);

    return res.status(200).json({ positions, totalValue });

  } catch(err) {
    console.error('Polymarket API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
