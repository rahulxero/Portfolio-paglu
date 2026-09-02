// api/hyperliquid.js — Hyperliquid wallet proxy
// Fetches HyperCore spot + perp balances AND HyperEVM native + token balances
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

  const post = (body, ms = 10000) =>
    fetch(HL_API, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });

  try {
    // ── 1. HyperCore spot balances ────────────────────────────
    try {
      const spotRes = await post({ type: 'spotClearinghouseState', user: address });
      if (spotRes.ok) {
        const spotData = await spotRes.json();
        for (const b of (spotData.balances || [])) {
          const total = parseFloat(b.total || 0);
          if (total <= 0) continue;
          positions.push({
            id: `hl-spot-${b.coin}`,
            symbol: b.coin,
            name: b.coin === 'USDC' ? 'USD Coin' : b.coin,
            chain: 'hyperliquid',
            balance: total,
            priceUSD: 0, valueUSD: 0, ch24: null, logo: '',
            source: 'hypercore-spot',
          });
        }
      }
    } catch (e) { console.warn('spotClearinghouseState failed:', e.message); }

    // ── 2. Perp account value (USDC margin) ───────────────────
    try {
      const perpRes = await post({ type: 'clearinghouseState', user: address });
      if (perpRes.ok) {
        const perpData = await perpRes.json();
        const accountValue = parseFloat(perpData.marginSummary?.accountValue || 0);
        if (accountValue > 0.01) {
          positions.push({
            id: 'hl-perp-margin',
            symbol: 'USDC',
            name: 'Perp Margin (USDC)',
            chain: 'hyperliquid',
            balance: accountValue,
            priceUSD: 1, valueUSD: accountValue, ch24: null, logo: '',
            source: 'hypercore-perp',
          });
        }
      }
    } catch (e) { console.warn('clearinghouseState failed:', e.message); }

    // ── 3. HyperEVM native HYPE ───────────────────────────────
    const HYPER_EVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
    const rpc = (method, params, id = 1) =>
      fetch(HYPER_EVM_RPC, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(8000),
      });

    try {
      const nativeRes = await rpc('eth_getBalance', [address, 'latest']);
      if (nativeRes.ok) {
        const nativeData = await nativeRes.json();
        const hypeBalance = parseInt(nativeData.result || '0x0', 16) / 1e18;
        if (hypeBalance > 0.0001) {
          positions.push({
            id: 'hyperevm-hype',
            symbol: 'HYPE',
            name: 'Hyperliquid (HyperEVM)',
            chain: 'hyperevm',
            balance: hypeBalance,
            priceUSD: 0, valueUSD: 0, ch24: null, logo: '',
            source: 'hyperevm-native',
          });
        }
      }
    } catch (e) { console.warn('HyperEVM native failed:', e.message); }

    // ── 4. HyperEVM ERC-20 token balances ─────────────────────
    // eth_getBalance ONLY returns native HYPE. ERC-20 tokens (USDC, USDT, etc.
    // bridged to HyperEVM) must be read from each token contract via balanceOf.
    // Hyperliquid's spotMeta exposes each token's EVM contract (evmContract.address).
    try {
      const metaRes = await post({ type: 'spotMeta' }, 8000);
      if (metaRes.ok) {
        const meta = await metaRes.json();
        // tokens: [{ name, weiDecimals, evmContract:{address, evm_extra_wei_decimals}, ... }]
        const evmTokens = (meta.tokens || []).filter(t => t.evmContract?.address);

        // balanceOf(address) selector = 0x70a08231 + 32-byte padded address
        const addrNoPrefix = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
        const callData = '0x70a08231' + addrNoPrefix;

        // Query each token contract (cap at 40 to stay within function time budget)
        const calls = evmTokens.slice(0, 40).map((t, i) =>
          rpc('eth_call', [{ to: t.evmContract.address, data: callData }, 'latest'], i + 10)
            .then(r => r.ok ? r.json() : null)
            .then(j => ({ token: t, hex: j?.result }))
            .catch(() => null)
        );
        const results = await Promise.all(calls);

        for (const out of results) {
          if (!out || !out.hex || out.hex === '0x') continue;
          const raw = BigInt(out.hex);
          if (raw === 0n) continue;
          const t = out.token;
          // On-chain decimals = weiDecimals + evm_extra_wei_decimals (per HL docs)
          const decimals = (t.weiDecimals || 0) + (t.evmContract.evm_extra_wei_decimals || 0);
          const bal = Number(raw) / Math.pow(10, decimals);
          if (bal <= 0) continue;
          positions.push({
            id: `hyperevm-${t.name}`,
            symbol: t.name,
            name: `${t.name} (HyperEVM)`,
            chain: 'hyperevm',
            balance: bal,
            priceUSD: 0, valueUSD: 0, ch24: null, logo: '',
            source: 'hyperevm-token',
          });
        }
      }
    } catch (e) { console.warn('HyperEVM tokens failed:', e.message); }

    // ── 5. Price everything (CoinGecko for what we can map) ────
    const COINGECKO_IDS = {
      HYPE: 'hyperliquid', BTC: 'bitcoin', ETH: 'ethereum', WETH: 'weth',
      USDC: 'usd-coin', USDT: 'tether', USDE: 'ethena-usde', SOL: 'solana',
      ARB: 'arbitrum', OP: 'optimism', AVAX: 'avalanche-2', LINK: 'chainlink',
      UNI: 'uniswap', AAVE: 'aave', PURR: 'purr-2', WBTC: 'wrapped-bitcoin',
    };
    const priceMap = {};
    const wantIds = [...new Set(positions.map(p => COINGECKO_IDS[p.symbol]).filter(Boolean))].join(',');
    if (wantIds) {
      try {
        const cgRes = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${wantIds}&vs_currencies=usd&include_24hr_change=true`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (cgRes.ok) {
          const cg = await cgRes.json();
          Object.entries(COINGECKO_IDS).forEach(([sym, id]) => {
            if (cg[id]) priceMap[sym] = { price: cg[id].usd || 0, ch24: cg[id].usd_24h_change ?? null };
          });
        }
      } catch (e) { console.warn('CoinGecko failed:', e.message); }
    }
    // Stables are $1 regardless of feed
    priceMap.USDC = { price: 1, ch24: 0 };
    priceMap.USDT = { price: 1, ch24: 0 };
    priceMap.USDE = priceMap.USDE || { price: 1, ch24: 0 };

    positions.forEach(p => {
      const info = priceMap[p.symbol];
      if (info) {
        p.priceUSD = info.price;
        p.valueUSD = p.balance * info.price;
        p.ch24 = info.ch24;
      }
      // Unpriced tokens keep priceUSD:0 / valueUSD:0 but are STILL returned,
      // so the frontend can show the balance even without a USD price.
    });

    positions.sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));
    return res.status(200).json({ positions });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
