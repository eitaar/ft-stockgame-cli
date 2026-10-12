import type { Hono } from 'hono';
import { pulseViaHttp } from './core/pulse.js';
import { createApp } from './core/server/app.js';
import { MemorySessionStore } from './core/session.js';

/**
 * Cloudflare Workers entry. No filesystem and no browser here, so:
 *  - the FT session cookie comes from a Worker secret (`STOCKGAME_COOKIE`);
 *  - the JWT is memoised in isolate memory (no KV needed);
 *  - the realtime fund feed uses the plain-HTTP Pulse transport (no websocket);
 *  - the MCP endpoint is protected by a bearer token and/or minimal OAuth (signed,
 *    stateless — still no KV), so an OAuth-only client such as a ChatGPT connector
 *    can connect.
 */
export interface Env {
  /** secret: the `FTSession_s` cookie value copied from your logged-in browser */
  STOCKGAME_COOKIE?: string;
  /** secret: static bearer accepted by `/mcp` (also the OAuth fallback secret/password) */
  STOCKGAME_MCP_TOKEN?: string;
  /** secret: HMAC key for OAuth tokens (falls back to STOCKGAME_MCP_TOKEN) */
  STOCKGAME_OAUTH_SECRET?: string;
  /** secret: password typed on the OAuth consent page (falls back to STOCKGAME_MCP_TOKEN) */
  STOCKGAME_OAUTH_PASSWORD?: string;
}

let app: Hono | undefined;

function buildApp(env: Env): Hono {
  const oauthSecret = env.STOCKGAME_OAUTH_SECRET ?? env.STOCKGAME_MCP_TOKEN;
  const oauthPassword = env.STOCKGAME_OAUTH_PASSWORD ?? env.STOCKGAME_MCP_TOKEN;

  return createApp({
    store: new MemorySessionStore(),
    cookieSource: async () => env.STOCKGAME_COOKIE ?? null,
    transport: pulseViaHttp,
    requireToken: env.STOCKGAME_MCP_TOKEN,
    oauth:
      oauthSecret && oauthPassword
        ? { secret: oauthSecret, password: oauthPassword, scope: 'stockgame' }
        : undefined,
  });
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    app ??= buildApp(env);
    return app.fetch(request);
  },
} satisfies { fetch: (request: Request, env: Env) => Response | Promise<Response> };
