import type { Api } from '../api.js';
import type { PulseTransport } from '../pulse.js';
import { validateOrder, type Order } from '../rules.js';

export interface ToolContext {
  /** Resolve (and cache) an authenticated API client for this server process. */
  api: () => Promise<Api>;
  /** Read a fund's live state (HTTP on Workers, WS on Node). */
  transport: PulseTransport;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ctx: ToolContext, args: Record<string, any>) => Promise<unknown>;
}

const num = (v: unknown): number | undefined => (v === undefined || v === null ? undefined : Number(v));

async function resolveFund(api: Api, fidArg?: unknown) {
  const user = await api.userdata();
  const funds = user.funds ?? [];
  if (funds.length === 0) throw new Error('no fund on this account');
  const fid = num(fidArg) ?? funds[0]![0];
  const fund = funds.find((f) => f[0] === fid);
  if (!fund) throw new Error(`fund ${fid} not found on this account`);
  return { user, fid, secret: user.secret ?? '' };
}

export const tools: ToolDef[] = [
  {
    name: 'whoami',
    description:
      'Account context: player id/name, active state, per-account realtime secret, and the funds with their league memberships.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (ctx) => (await ctx.api()).userdata(),
  },
  {
    name: 'portfolio',
    description:
      'Live fund state: current value, base, current picks (instrument -> percent), scheduled picks, per-pick day change, and position.',
    inputSchema: {
      type: 'object',
      properties: { fund: { type: 'number', description: 'fund id (defaults to the first fund)' } },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const { user, fid, secret } = await resolveFund(api, args.fund);
      const [state, universe] = await Promise.all([ctx.transport.fetchFund(fid, secret), api.universe()]);
      const byEid = (eid: string) =>
        Object.values(universe.overview.stocks).find((s) => s.eid === eid) ?? null;
      const picks = Object.entries(state.order ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([eid, pct]) => {
          const s = byEid(eid);
          return {
            eid,
            ticker: s?.ticker ?? eid,
            name: s?.displayName ?? '',
            alloc: pct,
            dayChange: state.sState?.[eid]?.[1] ?? null,
          };
        });
      return {
        fid,
        fundName: user.funds?.find((f) => f[0] === fid)?.[1] ?? null,
        value: state.v,
        base: state.b,
        reweighted: state.reweighted,
        position: state.pos ? { place: state.pos[0], outOf: state.pos[1] } : null,
        picks,
        scheduledPicks: state.next_opt ?? null,
        cash: 100 - picks.reduce((a, p) => a + p.alloc, 0),
      };
    },
  },
  {
    name: 'list_leagues',
    description: 'All leagues as [lid, name, x, y]; optionally only the leagues your funds are in.',
    inputSchema: {
      type: 'object',
      properties: { mineOnly: { type: 'boolean', description: 'only leagues you are in (default false)' } },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const [all, user] = await Promise.all([api.leagues(), api.userdata()]);
      const mine = new Set<number>();
      for (const [, , , leagues] of user.funds ?? []) for (const [lid] of leagues ?? []) mine.add(lid);
      const rows = (all ?? []).map(([lid, name, a, b]) => ({ lid, name, a, b, mine: mine.has(lid) }));
      return args.mineOnly ? rows.filter((r) => r.mine) : rows;
    },
  },
  {
    name: 'league_details',
    description: 'League page, member funds with values, and per-fund results/history.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number', description: 'league id' } },
      required: ['league'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const lid = Number(args.league);
      const [page, funds, results] = await Promise.all([
        api.leaguePage(lid),
        api.leagueFunds(lid),
        api.leagueFundResults(lid).catch(() => null),
      ]);
      return { page, funds, results };
    },
  },
  {
    name: 'player_profile',
    description: 'Player profile: followers, following, activity and funds.',
    inputSchema: {
      type: 'object',
      properties: { player: { type: 'number', description: 'player id' } },
      required: ['player'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => (await ctx.api()).player(Number(args.player)),
  },
  {
    name: 'search_players',
    description: 'Search players and their portfolios by name (the header search box). Returns pid/pname/funds.',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string', minLength: 1 } },
      required: ['term'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => (await ctx.api()).searchPlayers(String(args.term)),
  },
  {
    name: 'activity_feed',
    description: 'Private activity feed (other players’ reweights and follows).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (ctx) => (await ctx.api()).privateActivity(),
  },
  {
    name: 'stock_universe',
    description: 'Tradable instruments (eid, ticker, name, exchange, currency), optionally filtered by text.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string' } },
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const { overview, traded } = await api.universe();
      let stocks = Object.values(overview.stocks).filter((s) => traded[s.eid]);
      if (args.search) {
        const q = String(args.search).toLowerCase();
        stocks = stocks.filter(
          (s) => s.ticker.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q),
        );
      }
      return stocks;
    },
  },
  {
    name: 'list_negotiations',
    description: 'Pending fund <-> league negotiations for your player.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (ctx) => (await ctx.api()).playerNegotiations(),
  },
  {
    name: 'save_picks',
    description:
      'Save a fund’s picks (GUI "Save"). order is { instrumentKey: percent }. Enforces the game rules ' +
      '(5-20 picks, 5-25% each, 75-100% invested) unless allowInvalid. Use dryRun to validate only. ' +
      'Executes at the next market open, not immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        fund: { type: 'number' },
        order: { type: 'object', description: 'e.g. { "S4": 11, "S2": 8 }', additionalProperties: { type: 'number' } },
        dryRun: { type: 'boolean' },
        allowInvalid: { type: 'boolean' },
      },
      required: ['order'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const { fid } = await resolveFund(api, args.fund);
      const order = args.order as Order;
      const { errors, sum } = validateOrder(order);
      if (errors.length && !args.allowInvalid) {
        return { ok: false, fid, sum, errors, saved: false };
      }
      if (args.dryRun) return { ok: errors.length === 0, fid, sum, errors, saved: false, dryRun: true };
      const result = await api.reweight(fid, order);
      return { ok: true, fid, sum, errors, saved: true, result };
    },
  },
  {
    name: 'cancel_reweight',
    description: 'Cancel a fund’s scheduled (pending) reweight.',
    inputSchema: { type: 'object', properties: { fund: { type: 'number' } }, additionalProperties: false },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const { fid } = await resolveFund(api, args.fund);
      return api.cancelReweight(fid);
    },
  },
  {
    name: 'follow',
    description: 'Follow a player.',
    inputSchema: { type: 'object', properties: { player: { type: 'number' } }, required: ['player'], additionalProperties: false },
    handler: async (ctx, args) => (await ctx.api()).follow(Number(args.player)),
  },
  {
    name: 'unfollow',
    description: 'Unfollow a player.',
    inputSchema: { type: 'object', properties: { player: { type: 'number' } }, required: ['player'], additionalProperties: false },
    handler: async (ctx, args) => (await ctx.api()).unfollow(Number(args.player)),
  },
  {
    name: 'create_league',
    description: 'Create a league (name is 5-20 chars).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    handler: async (ctx, args) => (await ctx.api()).createLeague(String(args.name)),
  },
  {
    name: 'delete_league',
    description: 'Delete a league you own. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, confirm: { type: 'boolean' } },
      required: ['league', 'confirm'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      if (!args.confirm) throw new Error('delete_league requires confirm=true');
      return (await ctx.api()).deleteLeague(Number(args.league));
    },
  },
  {
    name: 'join_league',
    description: 'Join an open league with a fund.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, fund: { type: 'number' } },
      required: ['league'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const { fid } = await resolveFund(api, args.fund);
      return api.fundJoinLeague(fid, Number(args.league));
    },
  },
  {
    name: 'leave_league',
    description: 'Leave a league with a fund.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, fund: { type: 'number' } },
      required: ['league'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const { fid } = await resolveFund(api, args.fund);
      return api.fundLeaveLeague(fid, Number(args.league));
    },
  },
  {
    name: 'request_join',
    description: 'Request to join a private league with a fund.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, fund: { type: 'number' } },
      required: ['league'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const { fid } = await resolveFund(api, args.fund);
      return api.fundRequestToJoin(fid, Number(args.league));
    },
  },
  {
    name: 'reject_invite',
    description: 'Reject an invitation to a league.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, fund: { type: 'number' } },
      required: ['league'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const { fid } = await resolveFund(api, args.fund);
      return api.fundRejectInvite(fid, Number(args.league));
    },
  },
  {
    name: 'cancel_request',
    description: 'Cancel a pending request to join a league.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, fund: { type: 'number' } },
      required: ['league'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const { fid } = await resolveFund(api, args.fund);
      return api.fundCancelRequest(fid, Number(args.league));
    },
  },
  {
    name: 'league_invite',
    description: 'Owner: invite a fund to your league.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, fund: { type: 'number' } },
      required: ['league', 'fund'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => (await ctx.api()).leagueInviteFund(Number(args.league), Number(args.fund)),
  },
  {
    name: 'league_join',
    description: 'Owner: accept a fund into your league.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, fund: { type: 'number' } },
      required: ['league', 'fund'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => (await ctx.api()).leagueJoinFund(Number(args.league), Number(args.fund)),
  },
  {
    name: 'league_reject',
    description: 'Owner: reject a fund from your league.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, fund: { type: 'number' } },
      required: ['league', 'fund'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => (await ctx.api()).leagueRejectFund(Number(args.league), Number(args.fund)),
  },
  {
    name: 'league_reset',
    description: 'Owner: reset a decision for a fund.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, fund: { type: 'number' } },
      required: ['league', 'fund'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => (await ctx.api()).leagueResetDecision(Number(args.league), Number(args.fund)),
  },
  {
    name: 'negotiate',
    description: 'Decide a fund<->league negotiation as the fund.',
    inputSchema: {
      type: 'object',
      properties: { league: { type: 'number' }, fund: { type: 'number' }, accept: { type: 'boolean' } },
      required: ['league', 'fund', 'accept'],
      additionalProperties: false,
    },
    handler: async (ctx, args) =>
      (await ctx.api()).fundNegotiateDecision(Number(args.league), Number(args.fund), Boolean(args.accept)),
  },
  {
    name: 'raw_request',
    description: 'Escape hatch: call any API path directly. GET unless method is POST.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST'] },
        body: { type: 'object' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const api = await ctx.api();
      const method = String(args.method ?? (args.body ? 'POST' : 'GET')).toUpperCase();
      return method === 'GET' ? api.get(String(args.path)) : api.post(String(args.path), args.body ?? {});
    },
  },
];

export function findTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}
