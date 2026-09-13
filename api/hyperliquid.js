// api/hyperliquid.js — Hyperliquid + Lighter wallet proxy
// Fetches HyperCore spot/perp + HyperEVM tokens (via Hyperliquid)
// AND Lighter perp positions — combined to stay within Vercel's function limit
// No API key required for either service

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const HL_API = 'https://api.hyperliquid.xyz/info';
  const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai/api/v1';
  const headers = { 'Content-Type': 'application/json' };
  const positions = [];

  const post = (body, ms = 10000) =>
    fetch(HL_API, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });

  // Run Hyperliquid and Lighter fetches in parallel
  const [hlResult, lighterResult] = await Promise.allSettled([
    fetchHyperliquid(address, post, headers),
    fetchLighter(address, LIGHTER_API),
  ]);

  if (hlResult.status === 'fulfilled') positions.push(...hlResult.value);
  else console.warn('Hyperliquid fetch failed:', hlResult.reason?.message);

  if (lighterResult.status === 'fulfilled') positions.push(...lighterResult.value);
  else console.warn('Lighter fetch failed:', lighterResult.reason?.message);

  positions.sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));
  return res.status(200).json({ positions });
};

// ── HYPERLIQUID ────────────────────────────────────────────
async function fetchHyperliquid(address, post, headers) {
  const positions = [];

  // 1. HyperCore spot balances
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

  // 2. Perp account value (USDC margin)
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

  // 3. HyperEVM native HYPE
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

  // 4. HyperEVM ERC-20 token balances via spotMeta contracts
  try {
    const metaRes = await post({ type: 'spotMeta' }, 8000);
    if (metaRes.ok) {
      const meta = await metaRes.json();
      const evmTokens = (meta.tokens || []).filter(t => t.evmContract?.address);
      const addrNoPrefix = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      const callData = '0x70a08231' + addrNoPrefix;

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

  // 5. Price everything via CoinGecko
  const COINGECKO_IDS = {
    HYPE: 'hyperliquid', BTC: 'bitcoin', ETH: 'ethereum', WETH: 'weth',
    USDC: 'usd-coin', USDT: 'tether', USDE: 'ethena-usde', SOL: 'solana',
    ARB: 'arbitrum', OP: 'optimism', AVAX: 'avalanche-2', LINK: 'chainlink',
    UNI: 'uniswap', AAVE: 'aave', PURR: 'purr-2', WBTC: 'wrapped-bitcoin',
  };
  const priceMap = { USDC:{price:1,ch24:0}, USDT:{price:1,ch24:0}, USDE:{price:1,ch24:0} };
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
  positions.forEach(p => {
    const info = priceMap[p.symbol];
    if (info) { p.priceUSD = info.price; p.valueUSD = p.balance * info.price; p.ch24 = info.ch24; }
  });

  return positions;
}

// ── LIGHTER ────────────────────────────────────────────────
async function fetchLighter(address, BASE) {
  const positions = [];
  const get = (path, ms = 8000) =>
    fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(ms) });

  // Resolve EVM address → Lighter account indices
  const byAddrRes = await get(`/accountsByL1Address?l1_address=${encodeURIComponent(address)}`);
  if (!byAddrRes.ok) return positions;
  const byAddr = await byAddrRes.json();
  const subAccounts = byAddr.sub_accounts || [];
  if (!subAccounts.length) return positions;

  for (const sub of subAccounts) {
    const idx = sub.index;
    if (idx == null) continue;
    try {
      const accRes = await get(`/account?by=index&value=${idx}`);
      if (!accRes.ok) continue;
      const acc = await accRes.json();

      // Margin / collateral balance
      const marginBalance = parseFloat(acc.margin || acc.margin_balance || 0);
      if (marginBalance > 0.01) {
        positions.push({
          symbol: 'USDC', name: 'Lighter Margin (USDC)',
          chain: 'lighter', balance: marginBalance,
          priceUSD: 1, valueUSD: marginBalance, ch24: null, source: 'lighter-margin',
        });
      }

      // Open perpetual positions
      for (const pos of (acc.open_positions || acc.positions || [])) {
        const size = Math.abs(parseFloat(pos.size || pos.base_amount || 0));
        const markPrice = parseFloat(pos.mark_price || pos.oracle_price || 0);
        const notional = size * markPrice;
        if (notional < 0.01) continue;
        const symbol = (pos.market || pos.symbol || 'UNKNOWN')
          .replace('/USDC', '').replace('-PERP', '').replace('-USD', '');
        const isLong = parseFloat(pos.size || pos.base_amount || 0) > 0;
        positions.push({
          symbol, name: `${symbol} ${isLong ? 'Long' : 'Short'} (Lighter)`,
          chain: 'lighter', balance: size,
          priceUSD: markPrice, valueUSD: notional,
          ch24: null, isLong, source: 'lighter-perp',
        });
      }
    } catch (e) { console.warn(`Lighter account ${idx} failed:`, e.message); }
  }
  return positions;
}
