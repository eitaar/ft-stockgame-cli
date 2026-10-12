import type { Hono } from 'hono';
import { pulseViaHttp } from './core/pulse.js';
import { createApp } from './core/server/app.js';
import { MemorySessionStore } from './core/session.js';

/**
 * Cloudflare Workers entry. No filesystem and no browser here, so:
 *  - the FT session cookie comes from a Worker secret (`STOCKGAME_COOKIE`);
 *  - the JWT is memoised in isolate memory (no KV needed);
 *  - the realtime fund feed uses the plain-HTTP Pulse transport (no websocket).
 */
export interface Env {
  /** secret: the `FTSession_s` cookie value copied from your logged-in browser */
  STOCKGAME_COOKIE?: string;
  /** secret: when set, `/mcp` requires `Authorization: Bearer <value>` */
  STOCKGAME_MCP_TOKEN?: string;
}

let app: Hono | undefined;

function buildApp(env: Env): Hono {
  return createApp({
    store: new MemorySessionStore(),
    cookieSource: async () => env.STOCKGAME_COOKIE ?? null,
    transport: pulseViaHttp,
    requireToken: env.STOCKGAME_MCP_TOKEN,
  });
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    app ??= buildApp(env);
    return app.fetch(request);
  },
} satisfies { fetch: (request: Request, env: Env) => Response | Promise<Response> };
