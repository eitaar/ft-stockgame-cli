import { Hono } from 'hono';
import { Api } from '../api.js';
import { resolveAuth, type AuthOptions } from '../auth.js';
import { McpEndpoint, PROTOCOL_VERSION, SERVER_INFO } from './mcp.js';
import type { ToolContext } from './tools.js';

/** Build a lazily-authenticated Api bound to the server's auth options. */
export function createToolContext(auth: AuthOptions): ToolContext {
  let cached: Api | null = null;
  return {
    api: async () => {
      if (cached) return cached;
      const { token } = await resolveAuth(auth);
      cached = new Api(token, {
        onUnauthorized: async () => (await resolveAuth({ ...auth, token: undefined, refresh: true })).token,
      });
      return cached;
    },
  };
}

export interface AppOptions {
  auth?: AuthOptions;
}

/** The Hono app: `/health` plus the MCP Streamable HTTP endpoint at `/mcp`. */
export function createApp(opts: AppOptions = {}): Hono {
  const app = new Hono();
  const endpoint = new McpEndpoint(createToolContext(opts.auth ?? {}));

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

  app.post('/mcp', (c) => endpoint.post(c));
  app.get('/mcp', (c) => endpoint.get(c));
  app.delete('/mcp', (c) => endpoint.delete(c));

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => c.json({ error: err.message }, 500));

  return app;
}
