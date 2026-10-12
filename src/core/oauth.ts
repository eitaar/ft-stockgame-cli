/**
 * Minimal, stateless OAuth 2.1 authorization server for the MCP endpoint, so clients
 * that require OAuth (e.g. a ChatGPT connector) can connect.
 *
 * Everything is HMAC-signed and self-contained — no KV, no Durable Objects, no
 * database — which is what lets it run in a single Worker isolate:
 *   authorization code = signed {cc, ru, exp, ...}   (PKCE S256, short-lived)
 *   access token       = signed {t:"at", exp, scope}
 *   refresh token      = signed {t:"rt", exp, scope}
 *
 * The resource owner approves on a consent page by entering the configured password, so
 * only the account owner can mint a token even though the endpoints are public.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface OAuthConfig {
  /** HMAC key for signing tokens */
  secret: string;
  /** password the owner types on the consent page */
  password: string;
  scope?: string;
  accessTtlSec?: number;
  refreshTtlSec?: number;
  codeTtlSec?: number;
}

export interface OAuthContext {
  issuer: string;
  resource: string;
}

const DEFAULTS = { accessTtlSec: 3600, refreshTtlSec: 60 * 60 * 24 * 30, codeTtlSec: 300 };

export function oauthContext(requestUrl: string): OAuthContext {
  const origin = new URL(requestUrl).origin;
  return { issuer: origin, resource: `${origin}/mcp` };
}

// ---- base64url -------------------------------------------------------------

export function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeJson(value: unknown): string {
  return b64url(encoder.encode(JSON.stringify(value)));
}

// ---- signing ---------------------------------------------------------------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function sign(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = encodeJson(payload);
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return `${body}.${b64url(sig)}`;
}

async function verify<T = Record<string, unknown>>(secret: string, token: string): Promise<T | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const key = await hmacKey(secret);
    const signature = bytesFromB64url(sig) as unknown as BufferSource;
    const ok = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(decoder.decode(bytesFromB64url(body))) as Record<string, unknown>;
    const exp = typeof payload.exp === 'number' ? payload.exp : 0;
    if (exp && Date.now() > exp) return null;
    return payload as T;
  } catch {
    return null;
  }
}

async function pkceS256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  return b64url(digest);
}

// ---- discovery documents ---------------------------------------------------

export function protectedResourceMetadata(ctx: OAuthContext, scope: string) {
  return {
    resource: ctx.resource,
    authorization_servers: [ctx.issuer],
    scopes_supported: [scope],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(ctx: OAuthContext, scope: string) {
  return {
    issuer: ctx.issuer,
    authorization_endpoint: `${ctx.issuer}/oauth/authorize`,
    token_endpoint: `${ctx.issuer}/oauth/token`,
    registration_endpoint: `${ctx.issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [scope],
  };
}

/** Dynamic Client Registration (RFC 7591) — we accept any client and echo it back. */
export function registerClient(body: Record<string, unknown>): Record<string, unknown> {
  return {
    client_id: `dyn-${crypto.randomUUID()}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
    client_name: typeof body.client_name === 'string' ? body.client_name : 'mcp-client',
  };
}

// ---- authorization ---------------------------------------------------------

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope?: string;
  state?: string;
}

export async function issueCode(cfg: OAuthConfig, params: AuthorizeParams): Promise<string> {
  const ttl = cfg.codeTtlSec ?? DEFAULTS.codeTtlSec;
  return sign(cfg.secret, {
    t: 'code',
    exp: Date.now() + ttl * 1000,
    cid: params.clientId,
    ru: params.redirectUri,
    cc: params.codeChallenge,
    res: params.resource ?? null,
    scope: params.scope ?? cfg.scope ?? 'stockgame',
  });
}

export interface TokenResponse {
  status: number;
  body: Record<string, unknown>;
}

function oauthError(error: string, description: string, status = 400): TokenResponse {
  return { status, body: { error, error_description: description } };
}

export async function exchangeToken(cfg: OAuthConfig, form: URLSearchParams): Promise<TokenResponse> {
  const grant = form.get('grant_type');

  if (grant === 'refresh_token') {
    const payload = await verify<{ t?: string; scope?: string }>(cfg.secret, form.get('refresh_token') ?? '');
    if (!payload || payload.t !== 'rt') return oauthError('invalid_grant', 'bad refresh token');
    return {
      status: 200,
      body: {
        access_token: await sign(cfg.secret, {
          t: 'at',
          exp: Date.now() + (cfg.accessTtlSec ?? DEFAULTS.accessTtlSec) * 1000,
          scope: payload.scope ?? cfg.scope ?? 'stockgame',
        }),
        token_type: 'Bearer',
        expires_in: cfg.accessTtlSec ?? DEFAULTS.accessTtlSec,
        scope: payload.scope ?? cfg.scope ?? 'stockgame',
      },
    };
  }

  if (grant !== 'authorization_code') return oauthError('unsupported_grant_type', String(grant));

  const code = form.get('code') ?? '';
  const payload = await verify<{
    t?: string;
    cid?: string;
    ru?: string;
    cc?: string;
    scope?: string;
  }>(cfg.secret, code);
  if (!payload || payload.t !== 'code') return oauthError('invalid_grant', 'bad or expired code');

  const verifier = form.get('code_verifier') ?? '';
  if (!verifier) return oauthError('invalid_request', 'code_verifier required');
  if ((await pkceS256(verifier)) !== payload.cc) {
    return oauthError('invalid_grant', 'PKCE verification failed');
  }
  const redirectUri = form.get('redirect_uri');
  if (redirectUri && payload.ru && redirectUri !== payload.ru) {
    return oauthError('invalid_grant', 'redirect_uri mismatch');
  }

  const scope = payload.scope ?? cfg.scope ?? 'stockgame';
  return {
    status: 200,
    body: {
      access_token: await sign(cfg.secret, {
        t: 'at',
        exp: Date.now() + (cfg.accessTtlSec ?? DEFAULTS.accessTtlSec) * 1000,
        scope,
      }),
      token_type: 'Bearer',
      expires_in: cfg.accessTtlSec ?? DEFAULTS.accessTtlSec,
      refresh_token: await sign(cfg.secret, {
        t: 'rt',
        exp: Date.now() + (cfg.refreshTtlSec ?? DEFAULTS.refreshTtlSec) * 1000,
        scope,
      }),
      scope,
    },
  };
}

/** True when the bearer is a valid, unexpired OAuth access token we issued. */
export async function verifyAccessToken(cfg: OAuthConfig, token: string): Promise<boolean> {
  const payload = await verify<{ t?: string }>(cfg.secret, token);
  return payload?.t === 'at';
}

// ---- consent page ----------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

export function authorizePage(params: AuthorizeParams, error?: string): string {
  const hidden = Object.entries({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    resource: params.resource ?? '',
    scope: params.scope ?? '',
    state: params.state ?? '',
  })
    .filter(([, v]) => v)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}">`)
    .join('\n      ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ft-stockgame</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#111}
  h1{font-size:1.25rem;margin:0 0 .25rem}
  p{color:#444}
  code{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}
  .card{border:1px solid #e4e4e7;border-radius:12px;padding:1.25rem;margin-top:1rem}
  input[type=password]{width:100%;padding:.6rem;border:1px solid #d4d4d8;border-radius:8px;font:inherit;margin:.75rem 0}
  button{background:#111;color:#fff;border:0;border-radius:8px;padding:.6rem 1rem;font:inherit;cursor:pointer}
  .err{color:#b91c1c;margin:.5rem 0 0}
  .muted{color:#71717a;font-size:.85rem}
</style></head>
<body>
  <h1>Authorize <code>ft-stockgame</code></h1>
  <p>The client <code>${escapeHtml(params.clientId)}</code> is asking for access to your
  Stock Picking Game account through the MCP endpoint.</p>
  <div class="card">
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label for="password">Access password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
      <button type="submit">Authorize</button>
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
    </form>
    <p class="muted" style="margin-top:1rem">Only approve if you started this. The token
    grants full access to read and change your game account.</p>
  </div>
</body></html>`;
}
