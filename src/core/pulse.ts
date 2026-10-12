import { PULSE_HTTP_URL, PULSE_WS_URL } from './config.js';
import type { FundState } from './types.js';

/**
 * The game's realtime feed ("invest hubs"). Two transports, one shape:
 *  - HTTP:  POST /Pulse/Request/ with the same "manage" body (fetch only)
 *  - WS:    wss://.../Pulse/ with { seq, d: <manage body> }
 * Both answer with a fund snapshot keyed by instrument (order / next_opt / v / b).
 */
export interface PulseTransport {
  fetchFund(fid: number | string, secret: string, opts?: { timeoutMs?: number }): Promise<FundState>;
}

function manageBody(fid: number | string, secret: string) {
  return {
    _t: 'investHubs',
    subscribe: [{ hub: 'ff', area: 'ff', args: { _t: 'fund', fid: Number(fid), secret } }],
    queries: [],
    unsubscribe: ['ff'],
  };
}

function pickFund(entries: unknown[]): FundState | null {
  const results = entries.map((e) =>
    e && typeof e === 'object' && 'result' in e ? (e as { result: unknown }).result : e,
  );
  const fund = results.find(
    (r): r is FundState => !!r && typeof r === 'object' && 'order' in (r as object),
  );
  return fund ?? (results[0] as FundState | undefined) ?? null;
}

/** Plain-HTTP transport — works everywhere, including Cloudflare Workers. */
export const pulseViaHttp: PulseTransport = {
  async fetchFund(fid, secret, { timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(PULSE_HTTP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manageBody(fid, secret)),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`pulse: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: { subscribed?: unknown[] } | null };
      const fund = pickFund(json?.result?.subscribed ?? []);
      if (!fund) throw new Error('pulse: no fund result (check fid/secret)');
      return fund;
    } finally {
      clearTimeout(timer);
    }
  },
};

/** Websocket transport — used on Node/Bun/Deno. */
export const pulseViaSocket: PulseTransport = {
  fetchFund(fid, secret, { timeoutMs = 15000 } = {}) {
    return new Promise<FundState>((resolve, reject) => {
      const ws = new WebSocket(PULSE_WS_URL);
      const seq = 1000;
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('pulse: timed out waiting for response'));
      }, timeoutMs);

      const finish = (fn: (v: never) => void, arg: unknown) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        fn(arg as never);
      };

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ seq, d: manageBody(fid, secret) }));
      });
      ws.addEventListener('message', (ev: MessageEvent) => {
        let msg: { seqres?: number; d?: { subscribed?: unknown[] } };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.seqres !== seq || !msg.d) return;
        const fund = pickFund(msg.d.subscribed ?? []);
        if (!fund) return finish(reject as (v: never) => void, new Error('pulse: no fund result'));
        finish(resolve as (v: never) => void, fund);
      });
      ws.addEventListener('error', () =>
        finish(reject as (v: never) => void, new Error('pulse: socket error')),
      );
    });
  },
};
