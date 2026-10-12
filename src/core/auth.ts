import { HTTP_BASE, ORIGIN, GAME_URL } from './config.js';
import { MemorySessionStore, type SessionStore } from './session.js';
import type { JwtClaims, SessionData } from './types.js';

export interface AuthOptions {
  token?: string;
  cookie?: string;
  refresh?: boolean;
  validate?: boolean;
  /** where the FT cookie + JWT are cached (file on Node, memory on Workers) */
  store?: SessionStore;
  /** how to obtain the FT cookie when nothing is cached (CDP on Node, secret on Workers) */
  cookieSource?: () => Promise<string | null>;
}

export interface AuthResult {
  token: string;
  claims: JwtClaims | null;
  source: string;
  session?: SessionData | null;
}

const fallbackStore = new MemorySessionStore();

function decodeBase64Url(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const b64 = padded.padEnd(Math.ceil(padded.length / 4) * 4, '=');
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeJwt(token: string): JwtClaims | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(decodeBase64Url(payload)) as JwtClaims;
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

/**
 * Resolve a bearer token. Once one FT session cookie has been cached, refreshing is
 * fully self-contained: cached cookie -> /initialize -> fresh JWT. The cookie source
 * (DevTools on Node, a secret on Workers) is only consulted when nothing is cached.
 */
export async function resolveAuth({
  token,
  cookie,
  refresh = false,
  validate = true,
  store = fallbackStore,
  cookieSource,
}: AuthOptions = {}): Promise<AuthResult> {
  const session = store.read();

  const candidates: Array<{ value: string; source: string }> = [];
  if (token && !refresh) candidates.push({ value: token, source: '--token' });
  if (session?.token && !refresh) candidates.push({ value: session.token, source: 'cached token' });

  for (const c of candidates) {
    if (!validate || (await isAuthenticated(c.value))) {
      return { token: c.value, claims: decodeJwt(c.value), source: c.source, session };
    }
  }

  const findCookie = async (): Promise<{ cookie: string; source: string } | null> => {
    if (cookie) return { cookie, source: '--cookie' };
    if (session?.cookie) return { cookie: session.cookie, source: 'cached cookie' };
    const fromSource = cookieSource ? await cookieSource() : null;
    if (fromSource) return { cookie: fromSource, source: 'cookie source' };
    return null;
  };

  const persist = (value: string, result: { token: string; claims: JwtClaims | null }): void => {
    store.write({
      cookie: value,
      token: result.token,
      extId: result.claims?.extId,
      userId: result.claims?.uid,
      updatedAt: new Date().toISOString(),
    });
  };

  const found = await findCookie();
  if (!found) {
    throw new Error(
      'not logged in: no valid cached token and no session cookie available. ' +
        'Log in to ft.com in your browser, or pass --cookie / --token.',
    );
  }

  const result = await initialize(found.cookie);
  if (result && (!validate || (await isAuthenticated(result.token)))) {
    persist(found.cookie, result);
    return { token: result.token, claims: result.claims, source: `initialize (${found.source})` };
  }

  // Cached cookie went stale (expired or rotated): try one fresher source.
  if (!cookie) {
    const fresh = cookieSource ? await cookieSource() : null;
    if (fresh && fresh !== found.cookie) {
      const retry = await initialize(fresh);
      if (retry && (!validate || (await isAuthenticated(retry.token)))) {
        persist(fresh, retry);
        return { token: retry.token, claims: retry.claims, source: 'initialize (cookie source)' };
      }
    }
  }
  throw new Error(
    'not logged in: the FT session cookie was rejected (expired or rotated?). Log in again at ft.com.',
  );
}
