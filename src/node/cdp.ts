/**
 * Talk to a Chromium-family browser started with `--remote-debugging-port=<port>`
 * and pull the FT session cookie out of it. Node/Bun/Deno only (Workers has no
 * local browser, so there the cookie comes from a secret instead).
 */

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

interface BrowserVersion {
  webSocketDebuggerUrl: string;
  Browser?: string;
}

interface CdpApi {
  send: (method: string, params?: unknown) => Promise<unknown>;
  version: BrowserVersion;
}

async function withBrowserSocket<T>(
  port: number,
  fn: (api: CdpApi) => Promise<T>,
  timeoutMs = 8000,
): Promise<T> {
  let version: BrowserVersion;
  try {
    version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as BrowserVersion;
  } catch (err) {
    throw new Error(`no DevTools endpoint on 127.0.0.1:${port} (${(err as Error).message})`);
  }

  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map<number, (value: unknown) => void>();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`DevTools request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const send = (method: string, params: unknown = {}): Promise<unknown> =>
      new Promise((res) => {
        const mid = ++id;
        pending.set(mid, res);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });

    ws.addEventListener('open', async () => {
      try {
        const result = await fn({ send, version });
        clearTimeout(timer);
        ws.close();
        resolve(result);
      } catch (err) {
        clearTimeout(timer);
        ws.close();
        reject(err);
      }
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)?.(msg.result ?? msg.error);
        pending.delete(msg.id);
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('DevTools socket error'));
    });
  });
}

/** All cookies the browser holds (including HttpOnly ones). */
export async function browserCookies(port = 9222): Promise<BrowserCookie[]> {
  return withBrowserSocket(port, async ({ send }) => {
    const res = (await send('Storage.getCookies', {})) as { cookies?: BrowserCookie[] };
    return res?.cookies ?? [];
  });
}

/** Find the FT session cookie the game's bootstrap endpoint needs. */
export async function ftsessionCookie(port = 9222): Promise<string> {
  const cookies = await browserCookies(port);
  const match = cookies.find((c) => c.name === 'FTSession_s' && c.domain.endsWith('ft.com'));
  if (!match) throw new Error('FTSession_s cookie not found in the browser profile');
  return `${match.name}=${match.value}`;
}
