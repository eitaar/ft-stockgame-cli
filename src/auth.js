import { HTTP_BASE, ORIGIN, GAME_URL, readSession, writeSession } from './config.js';
import { ftsessionCookie } from './cdp.js';

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** GET /api/v1/user/initialize — exchanges the FT session cookie for a Norkon JWT. */
export async function initialize(cookie) {
  const res = await fetch(`${HTTP_BASE}v1/user/initialize`, {
    headers: { Cookie: cookie, Origin: ORIGIN, Referer: `${GAME_URL}` },
  });
  if (!res.ok) throw new Error(`initialize failed: HTTP ${res.status}`);
  const json = await res.json();
  const token = json?.result?.jwtToken;
  if (!token) return null;
  return { token, claims: decodeJwt(token) };
}

/**
 * Resolve a bearer token, in order of precedence:
 *   1. an explicit --token
 *   2. a still-valid cached token
 *   3. an FT session cookie (explicit, cached, or pulled from a running browser)
 */
export async function resolveAuth({ token, cookie, port = 9222, refresh = false } = {}) {
  if (token) {
    const claims = decodeJwt(token);
    return { token, claims, source: '--token' };
  }

  const session = readSession();

  if (!refresh && session?.token) {
    const claims = decodeJwt(session.token);
    const expMs = claims?.exp ? claims.exp * 1000 : 0;
    if (!expMs || expMs - Date.now() > 60_000) {
      return { token: session.token, claims, source: 'cached token', session };
    }
  }

  let cookieValue = cookie || session?.cookie;
  let cookieSource = cookie ? '--cookie' : 'cached cookie';
  if (!cookieValue) {
    cookieValue = await ftsessionCookie(port);
    cookieSource = `browser :${port}`;
  }

  const result = await initialize(cookieValue);
  if (!result) {
    throw new Error('not logged in: initialize returned no token (session expired?)');
  }
  writeSession({
    cookie: cookieValue,
    token: result.token,
    extId: result.claims?.extId,
    userId: result.claims?.uid,
    updatedAt: new Date().toISOString(),
  });
  return { token: result.token, claims: result.claims, source: `initialize (${cookieSource})` };
}
