import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { pulseViaSocket } from '../core/pulse.js';
import { createApp } from '../core/server/app.js';
import { ftsessionCookie } from './cdp.js';
import { FileSessionStore } from './store-file.js';

export interface ServeOptions {
  host: string;
  port: number;
  cookie?: string;
  token?: string;
  devtoolsPort?: number;
  /** false = never touch a browser (cached/explicit cookie only) */
  allowBrowser?: boolean;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Start the Hono app on whichever runtime we're on. The same app object is handed to
 * `Bun.serve`, `Deno.serve` or `@hono/node-server`, so the app itself is
 * runtime-agnostic.
 */
export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const devtoolsPort = opts.devtoolsPort ?? 9222;
  const oauthSecret = process.env.STOCKGAME_OAUTH_SECRET ?? opts.token;
  const oauthPassword = process.env.STOCKGAME_OAUTH_PASSWORD ?? opts.token;
  const app = createApp({
    store: new FileSessionStore(),
    cookieSource: async () =>
      opts.allowBrowser === false ? null : await ftsessionCookie(devtoolsPort).catch(() => null),
    transport: pulseViaSocket,
    requireToken: opts.token,
    oauth:
      oauthSecret && oauthPassword ? { secret: oauthSecret, password: oauthPassword } : undefined,
  });

  const url = `http://${opts.host}:${opts.port}`;
  const g = globalThis as any;

  if (g.Bun?.serve) {
    const server = g.Bun.serve({ hostname: opts.host, port: opts.port, fetch: app.fetch });
    return { url, close: async () => void server.stop() };
  }
  if (g.Deno?.serve) {
    const server = g.Deno.serve({ hostname: opts.host, port: opts.port }, app.fetch);
    return {
      url,
      close: async () => {
        server.shutdown();
      },
    };
  }

  const { serve } = await import('@hono/node-server');
  const server = serve({ hostname: opts.host, port: opts.port, fetch: app.fetch });
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Default export so runtimes that import the module (Bun/Deno) get an app. */
export default createApp({ transport: pulseViaSocket });

function readFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const host = readFlag('host') ?? process.env.STOCKGAME_HOST ?? '127.0.0.1';
  const port = Number(readFlag('port') ?? process.env.STOCKGAME_PORT ?? 8787);
  const noBrowser = process.argv.includes('--no-browser') || process.env.STOCKGAME_NO_BROWSER === '1';
  startServer({
    host,
    port,
    cookie: readFlag('cookie') ?? process.env.STOCKGAME_COOKIE,
    token: readFlag('token') ?? process.env.STOCKGAME_TOKEN,
    devtoolsPort: Number(readFlag('devtools-port') ?? 9222),
    allowBrowser: !noBrowser,
  })
    .then((server) => {
      process.stdout.write(
        `ft-stockgame server listening\n  MCP (Streamable HTTP): ${server.url}/mcp\n  health: ${server.url}/health\n`,
      );
    })
    .catch((err: Error) => {
      process.stderr.write(`failed to start: ${err.message}\n`);
      process.exit(1);
    });
}
