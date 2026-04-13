// api/check-alerts.js — checks price alerts and sends notifications
// Called by Vercel Cron (set in vercel.json) every 30 minutes
// Also used by /api/user.js after each price refresh

const { createClient } = require('@supabase/supabase-js');

async function sendTelegramMessage(chatId, text, botToken) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch(e) { console.error('Telegram error:', e); }
}

async function sendEmail(to, subject, text) {
  // Uses Resend free tier (100 emails/day free)
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'Portfolio Alert <alerts@' + (process.env.RESEND_DOMAIN || 'resend.dev') + '>',
        to: [to],
        subject,
        text,
      }),
    });
  } catch(e) { console.error('Email error:', e); }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  );

  try {
    // Get all active alerts
    const { data: alerts } = await sb
      .from('alerts')
      .select('*, auth.users!user_id(email)')
      .eq('active', true);

    if (!alerts?.length) return res.status(200).json({ checked: 0 });

    // Fetch current prices for all unique assets
    const assets = [...new Set(alerts.map(a => a.asset))];
    const prices = {};

    // Fetch crypto prices from CoinGecko
    const cryptoIds = {
      BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin',
      XRP:'ripple', ADA:'cardano', DOGE:'dogecoin', AVAX:'avalanche-2',
      MATIC:'matic-network', DOT:'polkadot', LINK:'chainlink', TRX:'tron',
    };
    const cryptoAssets = assets.filter(a => cryptoIds[a]);
    if (cryptoAssets.length) {
      const ids = cryptoAssets.map(a => cryptoIds[a]).join(',');
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
        const data = await r.json();
        cryptoAssets.forEach(a => {
          if (data[cryptoIds[a]]) prices[a] = data[cryptoIds[a]].usd;
        });
      } catch(e) {}
    }

    const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const fired = [];

    for (const alert of alerts) {
      const currentPrice = prices[alert.asset];
      if (currentPrice == null) continue;

      let shouldFire = false;
      let message = '';

      if (alert.type === 'price_below' && currentPrice <= alert.threshold) {
        shouldFire = true;
        message = `🔴 *${alert.asset}* dropped below *$${alert.threshold.toLocaleString()}*\nCurrent price: *$${currentPrice.toLocaleString()}*`;
      } else if (alert.type === 'price_above' && currentPrice >= alert.threshold) {
        shouldFire = true;
        message = `🟢 *${alert.asset}* rose above *$${alert.threshold.toLocaleString()}*\nCurrent price: *$${currentPrice.toLocaleString()}*`;
      }

      if (!shouldFire) continue;

      // Don't re-fire within 4 hours
      if (alert.last_fired) {
        const hoursSince = (Date.now() - new Date(alert.last_fired).getTime()) / 3600000;
        if (hoursSince < 4) continue;
      }

      // Send notification
      const userEmail = alert['auth.users']?.email;
      if (alert.channel === 'telegram' && alert.telegram_chat_id && TELEGRAM_TOKEN) {
        await sendTelegramMessage(alert.telegram_chat_id, message, TELEGRAM_TOKEN);
      } else if (userEmail) {
        const subject = `Portfolio Alert: ${alert.asset} ${alert.type === 'price_below' ? 'below' : 'above'} $${alert.threshold}`;
        await sendEmail(userEmail, subject, message.replace(/\*/g, ''));
      }

      // Mark as fired
      await sb.from('alerts').update({ last_fired: new Date().toISOString() }).eq('id', alert.id);
      fired.push(alert.id);
    }

    return res.status(200).json({ checked: alerts.length, fired: fired.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
