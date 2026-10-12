import { HTTP_BASE, ORIGIN, GAME_URL, readSession, writeSession } from './config.js';
import { ftsessionCookie } from './cdp.js';
import { cookieFromProfile } from './cookies.js';

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function tokenExpiry(token) {
  const claims = decodeJwt(token);
  return claims?.exp ? claims.exp * 1000 : 0;
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

function persist(cookie, result) {
  writeSession({
    cookie,
    token: result.token,
    extId: result.claims?.extId,
    userId: result.claims?.uid,
    updatedAt: new Date().toISOString(),
  });
}

/** Locate an FT session cookie: explicit, cached, live browser, then profile file. */
async function findCookie({ cookie, session, port, allowBrowser }) {
  if (cookie) return { cookie, source: '--cookie' };
  if (session?.cookie) return { cookie: session.cookie, source: 'cached cookie' };
  if (!allowBrowser) return null; // browser-free mode: only cached/explicit credentials
  try {
    return { cookie: await ftsessionCookie(port), source: `browser :${port}` };
  } catch {
    /* fall back to reading the profile directly */
  }
  const fromProfile = await cookieFromProfile();
  if (fromProfile) return { cookie: fromProfile, source: 'browser profile' };
  return null;
}

/**
 * The API answers an invalid/expired bearer token with HTTP 200 and an anonymous
 * userdata payload ({active:false}) rather than 401, so a token's validity has to be
 * probed rather than inferred from the status code.
 */
async function isAuthenticated(token) {
  try {
    const res = await fetch(`${HTTP_BASE}fantasyfunds/userdata`, {
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, Referer: `${GAME_URL}` },
    });
    const json = await res.json();
    return Boolean(json?.result?.player);
  } catch {
    return false;
  }
}

/**
 * Resolve a bearer token. Once one FT session cookie has been cached, refreshing is
 * fully self-contained inside the CLI: cached cookie -> /initialize -> fresh JWT,
 * with no browser or DevTools involved. The browser is only contacted when there is
 * no usable cookie yet, and any token that fails the validity probe is refreshed
 * automatically.
 */
export async function resolveAuth({
  token,
  cookie,
  port = 9222,
  refresh = false,
  allowBrowser = true,
  validate = true,
} = {}) {
  const session = readSession();

  const candidates = [];
  if (token && !refresh) candidates.push({ value: token, source: '--token' });
  if (session?.token && !refresh) candidates.push({ value: session.token, source: 'cached token' });

  for (const c of candidates) {
    if (!validate || (await isAuthenticated(c.value))) {
      return { token: c.value, claims: decodeJwt(c.value), source: c.source, session };
    }
  }

  const found = await findCookie({ cookie, session, port, allowBrowser });
  if (!found) {
    throw new Error(
      'not logged in: no valid cached token and no browser cookie found. ' +
        'Log in to ft.com in your browser, or pass --cookie / --token.',
    );
  }

  const tryCookie = async (source, value) => {
    const result = await initialize(value);
    if (result && (!validate || (await isAuthenticated(result.token)))) {
      persist(value, result);
      return { token: result.token, claims: result.claims, source: `initialize (${source})` };
    }
    return null;
  };

  const first = await tryCookie(found.source, found.cookie);
  if (first) return first;

  // Cached cookie went stale (expired or rotated): try one fresher source.
  const fresh = await findCookie({ cookie, session: null, port, allowBrowser: true });
  if (fresh && fresh.cookie !== found.cookie) {
    const second = await tryCookie(fresh.source, fresh.cookie);
    if (second) return second;
  }
  throw new Error('not logged in: the FT session cookie was rejected (expired or rotated?). Log in again at ft.com.');
}
