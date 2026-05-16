// api/hyperliquid.js — Hyperliquid wallet proxy
// Fetches HyperCore spot balances + HyperEVM token balances
// Hyperliquid API: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const HL_API = 'https://api.hyperliquid.xyz/info';
  const headers = { 'Content-Type': 'application/json' };
  const positions = [];

  try {
    // ── 1. Fetch spot token metadata (name/symbol mapping) ────
    let tokenMeta = {};
    try {
      const metaRes = await fetch(HL_API, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'spotMeta' }),
        signal: AbortSignal.timeout(8000),
      });
      if (metaRes.ok) {
        const meta = await metaRes.json();
        // tokens array: [{name, szDecimals, weiDecimals, index, tokenId, ...}]
        (meta.tokens || []).forEach(t => {
          tokenMeta[t.index] = { symbol: t.name, decimals: t.weiDecimals || 8 };
        });
        // universe has {name, tokens:[idx1,idx2]} — first token is base
        (meta.universe || []).forEach(u => {
          const baseIdx = u.tokens?.[0];
          if (baseIdx != null && tokenMeta[baseIdx]) {
            tokenMeta[baseIdx].pairName = u.name;
          }
        });
      }
    } catch(e) { console.warn('spotMeta failed:', e.message); }

    // ── 2. Fetch HyperCore spot balances ─────────────────────
    try {
      const spotRes = await fetch(HL_API, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'spotClearinghouseState', user: address }),
        signal: AbortSignal.timeout(10000),
      });
      if (spotRes.ok) {
        const spotData = await spotRes.json();
        // balances: [{coin, hold, total, entryNtl}]
        const balances = spotData.balances || [];

        for (const b of balances) {
          const total = parseFloat(b.total || 0);
          if (total <= 0) continue;

          positions.push({
            id: `hl-spot-${b.coin}`,
            symbol: b.coin,
            name: b.coin === 'USDC' ? 'USD Coin' : b.coin,
            chain: 'hyperliquid',
            balance: total,
            priceUSD: 0, // will be enriched via Jupiter/CoinGecko
            valueUSD: 0,
            ch24: null,
            logo: '',
            source: 'hypercore-spot',
          });
        }
      }
    } catch(e) { console.warn('spotClearinghouseState failed:', e.message); }

    // ── 3. Fetch perp account value (USDC in perp margin) ─────
    try {
      const perpRes = await fetch(HL_API, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'clearinghouseState', user: address }),
        signal: AbortSignal.timeout(10000),
      });
      if (perpRes.ok) {
        const perpData = await perpRes.json();
        const marginSummary = perpData.marginSummary || {};
        const accountValue = parseFloat(marginSummary.accountValue || 0);
        if (accountValue > 0.01) {
          positions.push({
            id: 'hl-perp-margin',
            symbol: 'USDC',
            name: 'Perp Margin (USDC)',
            chain: 'hyperliquid',
            balance: accountValue,
            priceUSD: 1,
            valueUSD: accountValue,
            ch24: null,
            logo: '',
            source: 'hypercore-perp',
          });
        }
      }
    } catch(e) { console.warn('clearinghouseState failed:', e.message); }

    // ── 4. Fetch HyperEVM token balances ──────────────────────
    // HyperEVM is EVM-compatible, RPC: https://rpc.hyperliquid.xyz/evm
    try {
      const HYPER_EVM_RPC = 'https://rpc.hyperliquid.xyz/evm';

      // Get native HYPE balance on HyperEVM
      const nativeRes = await fetch(HYPER_EVM_RPC, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_getBalance',
          params: [address, 'latest'],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (nativeRes.ok) {
        const nativeData = await nativeRes.json();
        const weiHex = nativeData.result || '0x0';
        const hypeBalance = parseInt(weiHex, 16) / 1e18;
        if (hypeBalance > 0.0001) {
          positions.push({
            id: 'hyperevm-hype',
            symbol: 'HYPE',
            name: 'Hyperliquid (HyperEVM)',
            chain: 'hyperevm',
            balance: hypeBalance,
            priceUSD: 0,
            valueUSD: 0,
            ch24: null,
            logo: '',
            source: 'hyperevm-native',
          });
        }
      }
    } catch(e) { console.warn('HyperEVM RPC failed:', e.message); }

    // ── 5. Get prices for all tokens ──────────────────────────
    // Use CoinGecko for HYPE + common tokens
    const priceMap = {};
    const symbolsToPrice = [...new Set(positions.map(p => p.symbol))];

    // Map known symbols to CoinGecko IDs
    const COINGECKO_IDS = {
      'HYPE': 'hyperliquid',
      'BTC': 'bitcoin',
      'ETH': 'ethereum',
      'USDC': 'usd-coin',
      'USDT': 'tether',
      'SOL': 'solana',
      'ARB': 'arbitrum',
      'OP': 'optimism',
      'AVAX': 'avalanche-2',
      'LINK': 'chainlink',
      'UNI': 'uniswap',
      'AAVE': 'aave',
      'PURR': 'purr-hyperliquid',
    };

    const coinIds = symbolsToPrice
      .map(s => COINGECKO_IDS[s])
      .filter(Boolean)
      .join(',');

    if (coinIds) {
      try {
        const cgRes = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${coinIds}&vs_currencies=usd&include_24hr_change=true`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (cgRes.ok) {
          const cgData = await cgRes.json();
          // Reverse map: coingecko id → price
          Object.entries(COINGECKO_IDS).forEach(([sym, id]) => {
            if (cgData[id]) {
              priceMap[sym] = {
                price: cgData[id].usd || 0,
                ch24: cgData[id].usd_24h_change || null,
              };
            }
          });
        }
      } catch(e) { console.warn('CoinGecko price fetch failed:', e.message); }
    }

    // USDC is always $1
    priceMap['USDC'] = { price: 1, ch24: 0 };
    priceMap['USDT'] = { price: 1, ch24: 0 };

    // Apply prices to positions
    positions.forEach(p => {
      const priceInfo = priceMap[p.symbol];
      if (priceInfo) {
        p.priceUSD = priceInfo.price;
        p.valueUSD = p.balance * priceInfo.price;
        p.ch24 = priceInfo.ch24;
      }
    });

    // Sort by value descending
    positions.sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));

    return res.status(200).json({ positions });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
