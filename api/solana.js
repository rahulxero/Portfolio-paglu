// api/solana.js — Solana wallet proxy
// Fetches SOL balance + all SPL token positions
// Uses Helius DAS API (free tier) + CoinGecko for prices

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { address } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
  const positions = [];

  try {
    // ── 1. Fetch native SOL balance ──────────────────────
    let solBalance = 0;
    const rpcs = [
      'https://api.mainnet-beta.solana.com',
      'https://rpc.ankr.com/solana',
    ];
    for (const rpc of rpcs) {
      try {
        const r = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getBalance', params:[address] }),
          signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) continue;
        const d = await r.json();
        if (d.result?.value != null) { solBalance = d.result.value / 1e9; break; }
      } catch(e) { continue; }
    }

    // ── 2. Fetch all token positions ─────────────────────
    let tokens = [];

    if (HELIUS_KEY) {
      // Use Helius DAS searchAssets — richest data
      try {
        const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'searchAssets',
            params: {
              ownerAddress: address,
              tokenType: 'fungible',
              displayOptions: { showNativeBalance: false, showZeroBalance: false },
              limit: 100,
            },
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) {
          const d = await r.json();
          tokens = d.result?.items || [];
        }
      } catch(e) {}
    }

    // Fallback: use standard getTokenAccountsByOwner RPC
    if (!tokens.length) {
      try {
        const rpc = 'https://api.mainnet-beta.solana.com';
        const r = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getTokenAccountsByOwner',
            params: [
              address,
              { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
              { encoding: 'jsonParsed' },
            ],
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) {
          const d = await r.json();
          tokens = (d.result?.value || []).map(acc => ({
            _type: 'rpc',
            mint: acc.account?.data?.parsed?.info?.mint,
            amount: acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0,
            decimals: acc.account?.data?.parsed?.info?.tokenAmount?.decimals || 0,
          })).filter(t => t.amount > 0 && t.mint);
        }
      } catch(e) {}
    }

    // ── 3. Get prices from Jupiter price API (free, no key) ──
    const mints = [];
    if (HELIUS_KEY) {
      tokens.forEach(t => {
        const mint = t.id || t.mint;
        if (mint) mints.push(mint);
      });
    } else {
      tokens.forEach(t => { if (t.mint) mints.push(t.mint); });
    }

    const prices = {};
    if (mints.length) {
      try {
        // Jupiter price API v2 — free, no key needed
        const chunks = [];
        for (let i = 0; i < mints.length; i += 100) chunks.push(mints.slice(i, i + 100));
        for (const chunk of chunks) {
          const r = await fetch(`https://api.jup.ag/price/v2?ids=${chunk.join(',')}`, {
            signal: AbortSignal.timeout(8000),
          });
          if (r.ok) {
            const d = await r.json();
            Object.assign(prices, d.data || {});
          }
        }
      } catch(e) {}
    }

    // ── 4. Build SOL native position ─────────────────────
    if (solBalance > 0) {
      const solPrice = prices['So11111111111111111111111111111111111111112']?.price || 0;
      positions.push({
        id: 'sol-native',
        symbol: 'SOL',
        name: 'Solana',
        chain: 'solana',
        balance: solBalance,
        priceUSD: solPrice,
        valueUSD: solBalance * solPrice,
        ch24: null,
        logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
        mint: 'So11111111111111111111111111111111111111112',
      });
    }

    // ── 5. Build SPL token positions ─────────────────────
    if (HELIUS_KEY && tokens.length) {
      for (const t of tokens) {
        const mint = t.id;
        const balance = t.token_info?.balance != null
          ? t.token_info.balance / Math.pow(10, t.token_info.decimals || 0)
          : 0;
        if (balance <= 0) continue;
        const priceInfo = prices[mint];
        const priceUSD = priceInfo?.price || t.token_info?.price_info?.price_per_token || 0;
        const valueUSD = balance * priceUSD;
        if (valueUSD < 0.01 && priceUSD === 0) continue; // skip unknown zero-value tokens

        positions.push({
          id: mint,
          symbol: (t.content?.metadata?.symbol || t.token_info?.symbol || mint.slice(0,4)).toUpperCase(),
          name: t.content?.metadata?.name || t.token_info?.symbol || 'Unknown Token',
          chain: 'solana',
          balance,
          priceUSD,
          valueUSD,
          ch24: null,
          logo: t.content?.links?.image || t.content?.files?.[0]?.uri || '',
          mint,
        });
      }
    } else if (!HELIUS_KEY && tokens.length) {
      // RPC fallback — we have mint + amount but no names/prices
      for (const t of tokens) {
        const priceInfo = prices[t.mint];
        const priceUSD = priceInfo?.price || 0;
        const valueUSD = t.amount * priceUSD;
        if (valueUSD < 0.01) continue;
        positions.push({
          id: t.mint,
          symbol: t.mint.slice(0, 4).toUpperCase(),
          name: 'SPL Token',
          chain: 'solana',
          balance: t.amount,
          priceUSD,
          valueUSD,
          ch24: null,
          logo: '',
          mint: t.mint,
        });
      }
    }

    // Sort by value descending
    positions.sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));

    return res.status(200).json({
      positions,
      hasHelius: !!HELIUS_KEY,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
