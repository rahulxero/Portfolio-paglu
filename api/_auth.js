// api/_auth.js — verifies Firebase ID tokens properly.
//
// The old decodeToken() base64-decoded the middle segment of the JWT and trusted
// whatever user_id it found. A JWT's signature is what proves Google issued it;
// without checking it, the token is just JSON anyone can type. This verifies the
// RS256 signature against Google's published keys, and checks issuer and audience.
//
// Files prefixed with _ are not routed by Vercel, so this is a helper, not an endpoint.

const { createRemoteJWKSet, jwtVerify } = require('jose');

// Google's public keys for Firebase ID tokens. jose caches these and respects
// the cache headers, so this is not a network call on every request.
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
  {
    timeoutDuration: 5000,      // don't let a stalled fetch hang the request
    cooldownDuration: 30000,    // and don't refetch on every failure
    cacheMaxAge: 600000,        // 10 min; Google rotates these slowly
  }
);

/**
 * @returns {Promise<{uid: string, email?: string} | null>} null if the token is
 *          missing, malformed, expired, forged, or issued for another project.
 */
async function verifyIdToken(authHeader) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    console.error('FIREBASE_PROJECT_ID is not set — refusing to authenticate anyone.');
    return null;
  }

  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    // jose already enforced exp and nbf. sub is the Firebase uid.
    const uid = payload.sub;
    if (!uid) return null;
    return { uid, email: payload.email };
  } catch (err) {
    // Wrong signature, expired, wrong project — all land here. Don't leak which.
    return null;
  }
}

module.exports = { verifyIdToken };
