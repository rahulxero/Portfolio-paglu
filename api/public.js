// api/public.js — public portfolio view via share slug (no auth)
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  try {
    // Get share link
    const { data: link, error: linkErr } = await sb
      .from('share_links')
      .select('user_id, show_values')
      .eq('slug', slug)
      .single();

    if (linkErr || !link) return res.status(404).json({ error: 'Portfolio not found' });

    // Get portfolio data
    const { data: portfolio, error: portErr } = await sb
      .from('portfolios')
      .select('data, currency, updated_at')
      .eq('user_id', link.user_id)
      .single();

    if (portErr) return res.status(404).json({ error: 'Portfolio not found' });

    // If show_values is false, strip balances/quantities
    let data = portfolio.data;
    if (!link.show_values) {
      // Return structure but zero out values
      data = {
        wallets: portfolio.data.wallets.map(w => ({ ...w, positions: [] })),
        btc: portfolio.data.btc.map(a => ({ ...a, balance: null })),
        others: portfolio.data.others.map(a => ({ ...a, balance: null })),
        indian: portfolio.data.indian.map(a => ({ ...a, qty: null, avgCost: null })),
        intl:   portfolio.data.intl.map(a => ({ ...a, qty: null, avgCost: null })),
        mf:     portfolio.data.mf.map(a => ({ ...a, units: null })),
        banks:  [],
      };
    }

    return res.status(200).json({
      data,
      currency: portfolio.currency,
      updated_at: portfolio.updated_at,
      show_values: link.show_values,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
