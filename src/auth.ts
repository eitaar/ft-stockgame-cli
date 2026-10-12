import { HTTP_BASE, ORIGIN, GAME_URL, readSession, writeSession } from './config.js';
import { ftsessionCookie } from './cdp.js';
import type { JwtClaims, SessionData } from './types.js';

export interface AuthResult {
  token: string;
  claims: JwtClaims | null;
  source: string;
  session?: SessionData | null;
}

export interface AuthOptions {
  token?: string;
  cookie?: string;
  port?: number;
  refresh?: boolean;
  allowBrowser?: boolean;
  validate?: boolean;
}

function decodeJwt(token: string): JwtClaims | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return null;
  }
}

export function tokenExpiry(token: string): number {
  const claims = decodeJwt(token);
  return claims?.exp ? claims.exp * 1000 : 0;
}

/** GET /api/v1/user/initialize — exchanges the FT session cookie for a Norkon JWT. */
export async function initialize(
  cookie: string,
): Promise<{ token: string; claims: JwtClaims | null } | null> {
  const res = await fetch(`${HTTP_BASE}v1/user/initialize`, {
    headers: { Cookie: cookie, Origin: ORIGIN, Referer: GAME_URL },
  });
  if (!res.ok) throw new Error(`initialize failed: HTTP ${res.status}`);
  const json = (await res.json()) as { result?: { jwtToken?: string } | null };
  const token = json?.result?.jwtToken;
  if (!token) return null;
  return { token, claims: decodeJwt(token) };
}

function persist(cookie: string, result: { token: string; claims: JwtClaims | null }): void {
  writeSession({
    cookie,
    token: result.token,
    extId: result.claims?.extId,
    userId: result.claims?.uid,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * The API answers an invalid/expired bearer token with HTTP 200 and an anonymous
 * userdata payload ({active:false}) rather than 401, so token validity has to be
 * probed rather than inferred from the status code.
 */
async function isAuthenticated(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${HTTP_BASE}fantasyfunds/userdata`, {
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, Referer: GAME_URL },
    });
    const json = (await res.json()) as { result?: { player?: unknown } };
    return Boolean(json?.result?.player);
  } catch {
    return false;
  }
}

/** Locate an FT session cookie: explicit, cached, then live browser. */
async function findCookie(args: {
  cookie?: string;
  session: SessionData | null;
  port: number;
  allowBrowser: boolean;
}): Promise<{ cookie: string; source: string } | null> {
  if (args.cookie) return { cookie: args.cookie, source: '--cookie' };
  if (args.session?.cookie) return { cookie: args.session.cookie, source: 'cached cookie' };
  if (!args.allowBrowser) return null; // browser-free mode: only cached/explicit credentials
  try {
    return { cookie: await ftsessionCookie(args.port), source: `browser :${args.port}` };
  } catch {
    return null;
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
}: AuthOptions = {}): Promise<AuthResult> {
  const session = readSession();

  const candidates: Array<{ value: string; source: string }> = [];
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

  const tryCookie = async (
    source: string,
    value: string,
  ): Promise<AuthResult | null> => {
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
  const fresh = await findCookie({ session: null, port, allowBrowser: true });
  if (fresh && fresh.cookie !== found.cookie) {
    const second = await tryCookie(fresh.source, fresh.cookie);
    if (second) return second;
  }
  throw new Error(
    'not logged in: the FT session cookie was rejected (expired or rotated?). Log in again at ft.com.',
  );
}
