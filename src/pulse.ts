import type { FundState } from './types.js';

export const WS_BASE = 'wss://api.ft-s02-prod.fantasy.norkon.net/Pulse/';

interface PulseArgs {
  area: string;
  hub: string;
  args: Record<string, unknown>;
}

export interface PulseRequest {
  subscribe?: PulseArgs[];
  queries?: PulseArgs[];
  unsubscribe?: string[];
}

export interface PulseResponse {
  subscribed?: FundState[];
  queried?: unknown[];
  queries?: unknown[];
}

/**
 * Low-level Pulse request. The game's realtime API ("invest hubs") is a websocket
 * that takes a single "manage" message per connection:
 *
 *   { seq, d: { _t: "investHubs", subscribe: [...], queries: [...], unsubscribe: [...] } }
 *
 * and answers with { seqres, d: { subscribed: [...], queries: [...] } }.
 * Uses the global WebSocket (Node 22+/Bun/Deno).
 */
export function pulseRequest(
  body: PulseRequest,
  { timeoutMs = 15000 }: { timeoutMs?: number } = {},
): Promise<PulseResponse> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE);
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
      const d = {
        _t: 'investHubs',
        subscribe: body.subscribe ?? [],
        queries: body.queries ?? [],
        unsubscribe: body.unsubscribe ?? [],
      };
      ws.send(JSON.stringify({ seq, d }));
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { seqres?: number; d?: { subscribed?: unknown[]; queried?: unknown[]; queries?: unknown[] } };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.seqres !== seq || !msg.d) return;
      const out: PulseResponse = {};
      if (Array.isArray(msg.d.subscribed)) {
        out.subscribed = msg.d.subscribed.map((s) => unwrap(s) as FundState);
      }
      if (Array.isArray(msg.d.queried)) out.queried = msg.d.queried.map(unwrap);
      if (Array.isArray(msg.d.queries)) out.queries = msg.d.queries.map(unwrap);
      finish(resolve as (v: never) => void, out);
    });

    ws.addEventListener('error', () => finish(reject as (v: never) => void, new Error('pulse: socket error')));
  });
}

function unwrap(entry: unknown): unknown {
  if (entry && typeof entry === 'object' && 'result' in entry) {
    return (entry as { result: unknown }).result;
  }
  return entry;
}

/** Read a fund's private state (current + scheduled picks, value, holdings). */
export async function fundState(
  fid: number | string,
  secret: string,
  opts?: { timeoutMs?: number },
): Promise<FundState> {
  const res = await pulseRequest(
    {
      subscribe: [{ hub: 'ff', area: 'ff', args: { _t: 'fund', fid: Number(fid), secret } }],
      unsubscribe: ['ff'],
    },
    opts,
  );
  const list = res.subscribed ?? [];
  const fund = list.find((r) => r && r.order !== undefined) ?? list[0];
  if (!fund) throw new Error('pulse: no fund result (check fid/secret)');
  return fund;
}
