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
  const wantDebug = req.query?.debug === '1' || req.body?.debug === true;
  const debugLog = wantDebug ? [] : null;

  const post = (body, ms = 10000) =>
    fetch(HL_API, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });

  // Run Hyperliquid and Lighter fetches in parallel
  const [hlResult, lighterResult] = await Promise.allSettled([
    fetchHyperliquid(address, post, headers),
    fetchLighter(address, debugLog),
  ]);

  if (hlResult.status === 'fulfilled') positions.push(...hlResult.value);
  else console.warn('Hyperliquid fetch failed:', hlResult.reason?.message);

  if (lighterResult.status === 'fulfilled') positions.push(...lighterResult.value);
  else console.warn('Lighter fetch failed:', lighterResult.reason?.message);

  positions.sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));
  return res.status(200).json(wantDebug ? { positions, _lighterDebug: debugLog } : { positions });
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
// Lighter splits across two hosts and the account can be addressed two ways,
// so each step falls back rather than failing silently. _debug reports what
// each attempt actually returned, surfaced via ?debug=1.
async function fetchLighter(address, debug) {
  const positions = [];
  const MAIN = 'https://mainnet.zklighter.elliot.ai/api/v1';
  const EXPLORER = 'https://explorer.elliot.ai/api';
  const log = (step, info) => { if (debug) debug.push({ step, ...info }); };

  const tryJson = async (url, ms = 8000) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { ok: r.ok, status: r.status, json, raw: text.slice(0, 400) };
    } catch (e) {
      return { ok: false, status: 0, json: null, raw: 'fetch error: ' + e.message };
    }
  };

  // ── Step 1: resolve the account (index + balances) ──
  let acct = null, accountIndex = null;

  let r = await tryJson(`${MAIN}/account?by=l1_address&value=${encodeURIComponent(address)}`);
  log('account?by=l1_address', { status: r.status, sample: r.raw });
  if (r.ok && r.json) {
    acct = Array.isArray(r.json.accounts) ? r.json.accounts[0] : (r.json.account || r.json);
    accountIndex = acct?.index ?? acct?.account_index ?? null;
  }

  if (!acct || accountIndex == null) {
    const r2 = await tryJson(`${MAIN}/accountsByL1Address?l1_address=${encodeURIComponent(address)}`);
    log('accountsByL1Address', { status: r2.status, sample: r2.raw });
    const subs = r2.json?.sub_accounts || r2.json?.accounts || [];
    if (subs.length) {
      accountIndex = subs[0].index ?? subs[0].account_index ?? null;
      if (accountIndex != null) {
        const r3 = await tryJson(`${MAIN}/account?by=index&value=${accountIndex}`);
        log('account?by=index', { status: r3.status, sample: r3.raw });
        if (r3.ok && r3.json) acct = Array.isArray(r3.json.accounts) ? r3.json.accounts[0] : (r3.json.account || r3.json);
      }
    }
  }

  if (!acct) { log('result', { note: 'no Lighter account found for this address' }); return positions; }

  // ── Step 2: collateral / margin balance ──
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const collateral = num(acct.collateral_value) || num(acct.collateral) ||
                     num(acct.available_balance) || num(acct.margin_balance) || num(acct.margin);
  log('collateral', { value: collateral, fields: Object.keys(acct || {}).slice(0, 25) });
  if (collateral > 0.01) {
    positions.push({
      symbol: 'USDC', name: 'Lighter Margin (USDC)', chain: 'lighter',
      balance: collateral, priceUSD: 1, valueUSD: collateral,
      ch24: null, source: 'lighter-margin',
    });
  }

  // ── Step 3: open perp positions ──
  let rawPositions = acct.positions || acct.open_positions || null;

  if (!rawPositions || !rawPositions.length) {
    for (const key of [address, accountIndex].filter(v => v != null)) {
      const rp = await tryJson(`${EXPLORER}/accounts/${encodeURIComponent(key)}/positions`);
      log(`explorer positions (${key === address ? 'address' : 'index'})`, { status: rp.status, sample: rp.raw });
      const list = rp.json?.positions || rp.json?.data || (Array.isArray(rp.json) ? rp.json : null);
      if (list && list.length) { rawPositions = list; break; }
    }
  }

  for (const p of (rawPositions || [])) {
    const signed = num(p.size ?? p.base_amount ?? p.position ?? p.amount);
    const size = Math.abs(signed);
    const mark = num(p.mark_price ?? p.oracle_price ?? p.price);
    const notional = (size && mark) ? size * mark : (num(p.position_value) || num(p.notional));
    if (notional < 0.01) continue;
    const symbol = String(p.market ?? p.symbol ?? p.market_symbol ?? p.asset_symbol ?? '')
      .replace('/USDC', '').replace('-PERP', '').replace('-USD', '').trim() || 'PERP';
    const isLong = signed >= 0;
    positions.push({
      symbol, name: `${symbol} ${isLong ? 'Long' : 'Short'} (Lighter)`, chain: 'lighter',
      balance: size, priceUSD: mark, valueUSD: notional,
      ch24: null, unrealizedPnl: num(p.unrealized_pnl), isLong,
      source: 'lighter-perp',
    });
  }

  // ── Step 4: spot assets ──
  if (!positions.length || debug) {
    const ra = await tryJson(`${EXPLORER}/accounts/${encodeURIComponent(address)}/assets`);
    log('explorer assets', { status: ra.status, sample: ra.raw });
    const assets = ra.json?.assets || ra.json?.data || (Array.isArray(ra.json) ? ra.json : []);
    for (const a of assets) {
      const sym = a.asset_symbol || a.symbol;
      const bal = num(a.balance);
      if (!sym || bal <= 0) continue;
      const px = (sym === 'USDC' || sym === 'USDT') ? 1 : 0;
      positions.push({
        symbol: sym, name: `${sym} (Lighter)`, chain: 'lighter',
        balance: bal, priceUSD: px, valueUSD: bal * px,
        ch24: null, source: 'lighter-spot',
      });
    }
  }

  log('result', { positionsFound: positions.length, accountIndex });
  return positions;
}
