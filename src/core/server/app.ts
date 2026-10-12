import { Hono } from 'hono';
import { Api } from '../api.js';
import { resolveAuth } from '../auth.js';
import {
  authorizationServerMetadata,
  authorizePage,
  exchangeToken,
  issueCode,
  oauthContext,
  protectedResourceMetadata,
  registerClient,
  verifyAccessToken,
  type AuthorizeParams,
  type OAuthConfig,
} from '../oauth.js';
import { pulseViaHttp, type PulseTransport } from '../pulse.js';
import { MemorySessionStore, type SessionStore } from '../session.js';
import { McpEndpoint, PROTOCOL_VERSION, SERVER_INFO } from './mcp.js';
import type { ToolContext } from './tools.js';

export interface AppDeps {
  /** session storage (file on Node, isolate memory on Workers) */
  store?: SessionStore;
  /** how to get the FT cookie when nothing is cached */
  cookieSource?: () => Promise<string | null>;
  /** realtime feed transport (HTTP by default) */
  transport?: PulseTransport;
  /** when set, /mcp accepts `Authorization: Bearer <requireToken>` */
  requireToken?: string;
  /** when set, exposes a minimal OAuth 2.1 server and accepts its access tokens */
  oauth?: OAuthConfig;
}

/** Build a lazily-authenticated Api + transport for the MCP tools. */
export function createToolContext(deps: AppDeps): ToolContext {
  const store = deps.store ?? new MemorySessionStore();
  let cached: Api | null = null;
  return {
    api: async () => {
      if (cached) return cached;
      const { token } = await resolveAuth({ store, cookieSource: deps.cookieSource });
      cached = new Api(token, {
        onUnauthorized: async () =>
          (await resolveAuth({ store, cookieSource: deps.cookieSource, refresh: true })).token,
      });
      return cached;
    },
    transport: deps.transport ?? pulseViaHttp,
  };
}

function authorizeParams(source: URLSearchParams): AuthorizeParams | null {
  const clientId = source.get('client_id');
  const redirectUri = source.get('redirect_uri');
  const codeChallenge = source.get('code_challenge');
  const responseType = source.get('response_type') ?? 'code';
  const method = source.get('code_challenge_method') ?? 'S256';
  if (!clientId || !redirectUri || !codeChallenge) return null;
  if (responseType !== 'code' || method.toUpperCase() !== 'S256') return null;
  return {
    clientId,
    redirectUri,
    codeChallenge,
    resource: source.get('resource') ?? undefined,
    scope: source.get('scope') ?? undefined,
    state: source.get('state') ?? undefined,
  };
}

/** The Hono app: `/health`, the MCP endpoint at `/mcp`, and (optionally) minimal OAuth. */
export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();
  const endpoint = new McpEndpoint(createToolContext(deps));
  const scope = deps.oauth?.scope ?? 'stockgame';

  app.get('/health', (c) =>
    c.json({ ok: true, ...SERVER_INFO, protocolVersion: PROTOCOL_VERSION }),
  );

  app.get('/', (c) =>
    c.json({
      service: SERVER_INFO.name,
      version: SERVER_INFO.version,
      mcp: '/mcp',
      transport: 'streamable-http',
      oauth: Boolean(deps.oauth),
    }),
  );

  // ---- OAuth 2.1 (discovery / DCR / authorize / token) --------------------
  if (deps.oauth) {
    const cfg = deps.oauth;
    const prm = (url: string) => protectedResourceMetadata(oauthContext(url), scope);
    const asm = (url: string) => authorizationServerMetadata(oauthContext(url), scope);

    app.get('/.well-known/oauth-protected-resource', (c) => c.json(prm(c.req.url)));
    app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(prm(c.req.url)));
    app.get('/.well-known/oauth-authorization-server', (c) => c.json(asm(c.req.url)));
    app.get('/.well-known/openid-configuration', (c) => c.json(asm(c.req.url)));

    app.post('/oauth/register', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      return c.json(registerClient(body), 201);
    });

    app.get('/oauth/authorize', (c) => {
      const params = authorizeParams(new URL(c.req.url).searchParams);
      if (!params) return c.html('<h1>invalid_request</h1>', 400);
      return c.html(authorizePage(params));
    });

    app.post('/oauth/authorize', async (c) => {
      const form = new URLSearchParams(await c.req.text());
      const params = authorizeParams(form);
      if (!params) return c.html('<h1>invalid_request</h1>', 400);
      if (form.get('password') !== cfg.password) {
        return c.html(authorizePage(params, 'Incorrect password'), 401);
      }
      const code = await issueCode(cfg, params);
      const target = new URL(params.redirectUri);
      target.searchParams.set('code', code);
      if (params.state) target.searchParams.set('state', params.state);
      return c.redirect(target.toString(), 302);
    });

    app.post('/oauth/token', async (c) => {
      const form = new URLSearchParams(await c.req.text());
      const { status, body } = await exchangeToken(cfg, form);
      return c.json(body, status as 200);
    });
  }

  // ---- /mcp guard ---------------------------------------------------------
  const gateConfigured = Boolean(deps.requireToken || deps.oauth);
  app.use('/mcp', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const staticOk = Boolean(deps.requireToken) && bearer === deps.requireToken;
    const oauthOk = deps.oauth ? await verifyAccessToken(deps.oauth, bearer) : false;
    if (gateConfigured && !(staticOk || oauthOk)) {
      const headers: Record<string, string> = {};
      if (deps.oauth) {
        const ctx = oauthContext(c.req.url);
        headers['WWW-Authenticate'] =
          `Bearer resource_metadata="${ctx.issuer}/.well-known/oauth-protected-resource"`;
      }
      return c.json({ error: 'unauthorized' }, 401, headers);
    }
    return next();
  });

  app.post('/mcp', (c) => endpoint.post(c));
  app.get('/mcp', (c) => endpoint.get(c));
  app.delete('/mcp', (c) => endpoint.delete(c));

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => c.json({ error: err.message }, 500));

  return app;
}
