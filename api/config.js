// api/config.js — returns public Firebase config to the frontend
// Firebase keys are safe to expose (protected by Firebase Security Rules)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  return res.status(200).json({
    firebaseApiKey:     process.env.FIREBASE_API_KEY     || '',
    firebaseAuthDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    firebaseProjectId:  process.env.FIREBASE_PROJECT_ID  || '',
    firebaseAppId:      process.env.FIREBASE_APP_ID      || '',
  });
};
