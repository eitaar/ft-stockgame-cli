import { Hono } from 'hono';
import { Api } from '../api.js';
import { resolveAuth } from '../auth.js';
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
  /** when set, /mcp requires `Authorization: Bearer <requireToken>` */
  requireToken?: string;
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

/** The Hono app: `/health` plus the MCP Streamable HTTP endpoint at `/mcp`. */
export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();
  const endpoint = new McpEndpoint(createToolContext(deps));

  app.get('/health', (c) =>
    c.json({ ok: true, ...SERVER_INFO, protocolVersion: PROTOCOL_VERSION }),
  );

  app.get('/', (c) =>
    c.json({
      service: SERVER_INFO.name,
      version: SERVER_INFO.version,
      mcp: '/mcp',
      transport: 'streamable-http',
    }),
  );

  // Optional bearer gate: when a token is configured, all MCP traffic must carry it.
  app.use('/mcp', async (c, next) => {
    if (!deps.requireToken) return next();
    if (c.req.header('authorization') !== `Bearer ${deps.requireToken}`) {
      return c.json({ error: 'unauthorized' }, 401);
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
