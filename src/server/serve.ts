import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { AuthOptions } from '../auth.js';
import { createApp } from './app.js';

export interface ServeOptions {
  host: string;
  port: number;
  auth?: AuthOptions;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Start the Hono app on whichever runtime we're on. The same app object is passed
 * to `Bun.serve`, `Deno.serve` or `@hono/node-server`, so nothing in the app itself
 * is runtime-specific.
 */
export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const app = createApp({ auth: opts.auth ?? {} });
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

/** Escape hatch for runtimes that import the default export (Bun/Deno). */
export default createApp({});

function readFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const host = readFlag('host') ?? process.env.STOCKGAME_HOST ?? '127.0.0.1';
  const port = Number(readFlag('port') ?? process.env.STOCKGAME_PORT ?? 8787);
  const cookie = readFlag('cookie') ?? process.env.STOCKGAME_COOKIE;
  const token = readFlag('token') ?? process.env.STOCKGAME_TOKEN;
  const noBrowser = process.argv.includes('--no-browser') || process.env.STOCKGAME_NO_BROWSER === '1';
  const devPort = Number(readFlag('devtools-port') ?? 9222);
  startServer({
    host,
    port,
    auth: { cookie, token, port: devPort, allowBrowser: !noBrowser },
  })
    .then((server) => {
      process.stdout.write(
        `${SERVER_LINE}\n  MCP (Streamable HTTP): ${server.url}/mcp\n  health: ${server.url}/health\n`,
      );
    })
    .catch((err: Error) => {
      process.stderr.write(`failed to start: ${err.message}\n`);
      process.exit(1);
    });
}

const SERVER_LINE = 'ft-stockgame server listening';
