// api/config.js — returns public Supabase config to the frontend
// Safe to expose: SUPABASE_URL and ANON_KEY are public-facing by design
// The anon key is protected by Row Level Security policies in Supabase

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // cache 1hr
  if (req.method === 'OPTIONS') return res.status(200).end();

  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseKey: process.env.SUPABASE_ANON_KEY || '',
  });
};
