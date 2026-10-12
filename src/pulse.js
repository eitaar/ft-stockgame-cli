import WebSocket from 'ws';

export const WS_BASE = 'wss://api.ft-s02-prod.fantasy.norkon.net/Pulse/';
export const ORIGIN = 'https://stockpickinggame.ft.com';

/**
 * Low-level Pulse request. The game's realtime API ("invest hubs") is a
 * websocket that takes a single "manage" message per connection:
 *
 *   { seq, d: { _t: "investHubs", subscribe: [...], queries: [...], unsubscribe: [...] } }
 *
 * and answers with { seqres, d: { subscribed: [...], queries: [...] } }.
 */
export function pulseRequest({ subscribe = [], queries = [], unsubscribe = [] }, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE, { origin: ORIGIN });
    const seq = 1000;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('pulse: timed out waiting for response'));
    }, timeoutMs);

    const finish = (fn, arg) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      fn(arg);
    };

    ws.on('open', () => {
      const d = { _t: 'investHubs', subscribe, queries, unsubscribe };
      ws.send(JSON.stringify({ seq, d }));
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.seqres !== seq || !msg.d) return;
      const out = {};
      if (Array.isArray(msg.d.subscribed)) out.subscribed = msg.d.subscribed.map((s) => s.result ?? s);
      if (Array.isArray(msg.d.queried)) out.queried = msg.d.queried.map((s) => s.result ?? s);
      if (Array.isArray(msg.d.queries)) out.queries = msg.d.queries.map((s) => s.result ?? s);
      finish(resolve, out);
    });

    ws.on('error', (err) => finish(reject, new Error(`pulse: ${err.message}`)));
    ws.on('unexpected-response', (_req, res) => finish(reject, new Error(`pulse: unexpected-response ${res.statusCode}`)));
  });
}

/** Read a fund's private state (current + scheduled order, value, holdings). */
export async function fundState(fid, secret, opts) {
  const res = await pulseRequest(
    { subscribe: [{ hub: 'ff', area: 'ff', args: { _t: 'fund', fid: Number(fid), secret } }], unsubscribe: ['ff'] },
    opts,
  );
  const list = res.subscribed ?? [];
  const fund = list.find((r) => r && r.order !== undefined) ?? list[0];
  if (!fund) throw new Error('pulse: no fund result (check fid/secret)');
  return fund;
}
