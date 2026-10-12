import WebSocket from 'ws';

/**
 * Talk to a Chromium-family browser that was started with
 * `--remote-debugging-port=<port>` and pull the FT session cookie out of it.
 * This is what lets the CLI reuse the already-logged-in browser session.
 */
async function withBrowserSocket(port, fn, timeoutMs = 8000) {
  let version;
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  } catch (err) {
    throw new Error(`no DevTools endpoint on 127.0.0.1:${port} (${err.message})`);
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`DevTools request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const send = (method, params = {}) =>
      new Promise((res) => {
        const mid = ++id;
        pending.set(mid, res);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });

    ws.on('open', async () => {
      try {
        const result = await fn({ send, version });
        clearTimeout(timer);
        ws.close();
        resolve(result);
      } catch (err) {
        clearTimeout(timer);
        ws.terminate();
        reject(err);
      }
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result ?? msg.error);
        pending.delete(msg.id);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`DevTools socket error: ${err.message}`));
    });
  });
}

/** All cookies the browser holds (including HttpOnly). */
export async function browserCookies(port = 9222) {
  return withBrowserSocket(port, async ({ send }) => {
    const res = await send('Storage.getCookies', {});
    return res?.cookies ?? [];
  });
}

/** Find the FT session cookie the game's bootstrap endpoint needs. */
export async function ftsessionCookie(port = 9222) {
  const cookies = await browserCookies(port);
  const match = cookies.find(
    (c) => c.name === 'FTSession_s' && (c.domain === '.ft.com' || c.domain.endsWith('ft.com')),
  );
  if (!match) throw new Error('FTSession_s cookie not found in the browser profile');
  return `${match.name}=${match.value}`;
}
