#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs';
import { Api, ApiError } from '../core/api.js';
import { resolveAuth } from '../core/auth.js';
import { pulseViaSocket } from '../core/pulse.js';
import { GICS } from '../core/config.js';
import { validateOrder, parseOrderSpec } from '../core/rules.js';
import { money, signedPct, table, ts } from '../core/format.js';
import type { PlayerData, Universe } from '../core/types.js';
import { ftsessionCookie } from './cdp.js';
import { FileSessionStore, SESSION_FILE } from './store-file.js';

type Flags = Record<string, string | boolean>;
interface Parsed {
  _: string[];
  flags: Flags;
}

const store = new FileSessionStore();

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

const HELP = `stockgame - drive the FT Stock Picking Game from the CLI or an MCP client

Usage: stockgame <command> [options]

Connection
  auth [--refresh]            Resolve/refresh the session (uses the logged-in browser)
  whoami                      Show user, player, funds and token status
  config                      Show config paths
  serve                       Start the Hono HTTP + MCP server (Streamable HTTP at /mcp)

Read (GUI equivalent)
  portfolio [--fund <fid>]    Live fund state: value, picks, exposure, scheduled trades
  leagues [--all]             List leagues (default: only yours)
  league <lid>                League page, funds and returns
  player <pid> [--fund <fid>] Player profile, followers/following, activity
  activity                    Private activity feed
  stocks [--search <text>]    Traded stock universe
  invites                     Pending invitations / negotiations
  requests <lid>              Negotiations for a league you own

Write (GUI equivalent)
  reweight --fund <fid>       Save picks. Sources: --set "S4=11,S2=8" | --file picks.json | --current
                              extras: --dry-run, --allow-invalid
  cancel-reweight --fund <fid>
  follow <pid> | unfollow <pid>
  create-league <name>
  delete-league <lid> --yes
  fund-join <lid> --fund <fid>        Join an open league
  fund-request <lid> --fund <fid>     Request to join a private league
  fund-leave <lid> --fund <fid>       Leave a league
  fund-reject <lid> --fund <fid>      Reject an invitation
  fund-cancel <lid> --fund <fid>      Cancel a pending join request
  league-invite <lid> <fid>           Invite a fund (owner)
  league-join <lid> <fid>             Accept a fund (owner)
  league-reject <lid> <fid>           Reject a fund (owner)
  league-reset <lid> <fid>            Reset a decision (owner)
  negotiate <lid> <fid> --accept|--reject    Decide a fund<->league negotiation

Raw / escape hatch
  raw <path> [--method GET|POST] [--data '<json>']

Global options
  --json        Machine-readable output
  --token <jwt> Use a bearer token directly
  --cookie <c>  Use an FT session cookie directly (bootstrap without a browser)
  --no-browser  Never contact the browser: refresh using only the cached credentials
  --port <n>    DevTools port of the logged-in browser (default 9222)
  -h, --help    Show this help

Auth model
  The FT session cookie (FTSession_s) is the root credential; the game's JWT is
  derived from it via /v1/user/initialize. Once one cookie is cached, every later
  run refreshes the JWT on its own — no browser involved — until the FT session
  itself expires (~6 months). Use --no-browser to enforce that.
`;

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq > 0) out.flags[body.slice(0, eq)] = body.slice(eq + 1);
      else if (i + 1 < argv.length && !(argv[i + 1] as string).startsWith('--'))
        out.flags[body] = argv[++i] as string;
      else out.flags[body] = true;
    } else if (/^-[a-z]$/.test(a)) {
      const k = a.slice(1);
      if (i + 1 < argv.length && !(argv[i + 1] as string).startsWith('-'))
        out.flags[k] = argv[++i] as string;
      else out.flags[k] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Positional arguments captured by parseArgs under the `_` key. */
function pos(flags: Flags): string[] {
  return (flags._ as unknown as string[]) ?? [];
}

function authOptions(flags: Flags) {
  const noBrowser = Boolean(flags['no-browser']) || process.env.STOCKGAME_NO_BROWSER === '1';
  const port = flags.port ? Number(flags.port) : 9222;
  return {
    token: str(flags.token),
    cookie: str(flags.cookie),
    refresh: Boolean(flags.refresh),
    store,
    cookieSource: async () => (noBrowser ? null : await ftsessionCookie(port).catch(() => null)),
  };
}

async function makeApi(flags: Flags) {
  const opts = authOptions(flags);
  const { token, claims, source } = await resolveAuth(opts);
  const api = new Api(token, {
    // Transparent token refresh: if any call comes back unauthorized, re-initialize
    // from the cached cookie and retry once, without the caller noticing.
    onUnauthorized: async () => (await resolveAuth({ ...opts, token: undefined, refresh: true })).token,
  });
  return { api, claims: claims as Record<string, unknown> | null, source };
}

async function currentFund(api: Api, flags: Flags) {
  const user = await api.userdata();
  const funds = user?.funds ?? [];
  if (funds.length === 0) die('no fund on this account');
  const fid = flags.fund ? Number(flags.fund) : (funds[0] as [number, ...unknown[]])[0];
  const fund = funds.find((f) => f[0] === fid);
  if (!fund) die(`fund ${fid} not found on this account`);
  return { user, fund, fid, secret: user.secret ?? '' };
}

function stockByEid(universe: { overview?: Universe }, eid: string) {
  const stocks = universe?.overview?.stocks ?? {};
  return Object.values(stocks).find((s) => s.eid === eid) ?? null;
}

// --------------------------------------------------------------------------

async function cmdAuth(flags: Flags): Promise<void> {
  const { claims, source } = await makeApi(flags);
  const s = store.read();
  const expSec = Number(claims?.exp ?? 0);
  const exp = expSec ? new Date(expSec * 1000) : null;
  const minsLeft = exp ? Math.round((exp.getTime() - Date.now()) / 60000) : null;
  if (flags.json) {
    printJson({ source, expiresAt: exp?.toISOString() ?? null, claims, cookieCached: Boolean(s?.cookie) });
    return;
  }
  console.log(`auth source : ${source}`);
  console.log(`token exp   : ${exp ? exp.toISOString() : '-'}${minsLeft != null ? `  (in ${minsLeft} min)` : ''}`);
  console.log(`cookie      : ${s?.cookie ? 'cached (refreshes without the browser)' : 'not cached yet'}`);
  console.log(`extId       : ${String(claims?.extId ?? '-')}`);
  console.log(`userId      : ${String(claims?.uid ?? '-')}`);
}

async function cmdWhoami(flags: Flags): Promise<void> {
  const { api, source } = await makeApi(flags);
  const user = await api.userdata();
  if (flags.json) {
    printJson({ source, user });
    return;
  }
  console.log(`auth        : ${source}`);
  console.log(`user        : ${user?.player?.name ?? '-'} (player #${user?.player?.id ?? '-'})  userId ${user?.userId ?? '-'}`);
  console.log(`active      : ${user?.active}`);
  console.log(`secret      : ${user?.secret ?? '-'}`);
  console.log('\nfunds:');
  for (const [fid, fname, active, leagues] of user?.funds ?? []) {
    console.log(`  #${fid} ${fname}${active ? ' (active)' : ''}`);
    for (const [lid, lname] of leagues ?? []) console.log(`      league #${lid} ${lname}`);
  }
}

function cmdConfig(): void {
  console.log(`session file: ${SESSION_FILE}`);
  const s = store.read();
  console.log(`session     : ${s ? `present (updated ${s.updatedAt ?? '?'})` : 'none'}`);
}

async function cmdPortfolio(flags: Flags): Promise<void> {
  const { api } = await makeApi(flags);
  const { user, fid, secret } = await currentFund(api, flags);
  const [state, universe] = await Promise.all([
    pulseViaSocket.fetchFund(fid, secret),
    api.universe(),
  ]);

  if (flags.json) {
    printJson({ fid, state });
    return;
  }

  const picks = Object.entries(state.order ?? {}).sort((a, b) => b[1] - a[1]);
  const scheduled = state.next_opt && Object.keys(state.next_opt).length ? state.next_opt : null;

  const fundName = user.funds?.find((f) => f[0] === fid)?.[1] ?? `#${fid}`;
  console.log(`fund   : ${fundName} (#${fid})`);
  console.log(
    `value  : ${money(state.v, 2)}   base: ${money(state.b, 2)}   ${state.reweighted ? '(reweight scheduled)' : ''}`,
  );
  const rows = picks.map(([eid, pct]) => {
    const s = stockByEid(universe, eid);
    const chg = state.sState?.[eid]?.[1];
    return [eid, s?.ticker ?? eid, s?.displayName ?? '', `${pct}%`, chg == null ? '-' : signedPct(chg)];
  });
  console.log('\n' + table(['eid', 'ticker', 'name', 'alloc', 'day chg'], rows));

  const cash = 100 - picks.reduce((a, [, p]) => a + p, 0);
  console.log(`\ninvested: ${100 - cash}%   cash: ${cash}%`);

  if (scheduled) {
    const changes: Array<Array<string | number>> = [];
    const ids = new Set([...Object.keys(state.order ?? {}), ...Object.keys(scheduled)]);
    for (const eid of ids) {
      const now = state.order?.[eid] ?? 0;
      const next = scheduled[eid] ?? 0;
      if (now !== next) changes.push([eid, `${now}%`, `${next}%`, next === 0 ? 'sell' : now === 0 ? 'buy' : 'adjust']);
    }
    console.log('\nscheduled changes (next market open):');
    console.log(table(['eid', 'now', 'next', 'action'], changes));
  }

  const exposure = new Map<string, number>();
  for (const [eid, pct] of picks) {
    const s = stockByEid(universe, eid);
    const key = s ? (GICS[Number(s.gics)] ?? `gics ${s.gics}`) : 'unknown';
    exposure.set(key, (exposure.get(key) ?? 0) + pct);
  }
  console.log('\nexposure:');
  for (const [k, v] of [...exposure.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}%`);
  if (cash > 0) console.log(`  Cash: ${cash}%`);
}

async function cmdLeagues(flags: Flags): Promise<void> {
  const { api } = await makeApi(flags);
  const user = await api.userdata();
  const mine = new Set<number>();
  for (const [, , , leagues] of user?.funds ?? []) for (const [lid] of leagues ?? []) mine.add(lid);

  const all = await api.leagues();
  if (flags.json) {
    printJson(all);
    return;
  }
  let rows: Array<Array<string | number>> = (all ?? []).map(([lid, name, a, b]) => [
    lid,
    name,
    a,
    b,
    mine.has(lid) ? '*' : '',
  ]);
  if (!flags.all) rows = rows.filter((r) => r[4] === '*');
  console.log(table(['lid', 'name', 'members?', 'x', 'mine'], rows));
}

async function cmdLeague(flags: Flags): Promise<void> {
  const lid = Number(pos(flags)[0]);
  if (!lid) die('usage: stockgame league <lid>');
  const { api } = await makeApi(flags);
  const [page, funds, results] = await Promise.all([
    api.leaguePage(lid),
    api.leagueFunds(lid),
    api.leagueFundResults(lid).catch(() => null),
  ]);
  if (flags.json) {
    printJson({ page, funds, results });
    return;
  }
  console.log(`league: ${funds?.name ?? page?.lname ?? '?'} (#${lid})`);
  console.log(`owned: ${page?.owned}  canJoin: ${page?.canJoin}  canLeave: ${page?.canLeave}`);
  const rows = (funds?.funds ?? []).map(([fid, fname, , pid, pname]) => [
    fid,
    fname,
    pname,
    money(funds?.ress?.[String(fid)] ?? null, 2),
  ]);
  console.log('\n' + table(['fid', 'fund', 'player', 'value'], rows));
  if (results) {
    console.log('\nresults:');
    console.log(typeof results === 'string' ? results : JSON.stringify(results, null, 2));
  }
}

async function cmdPlayer(flags: Flags): Promise<void> {
  const pid = pos(flags)[0];
  if (!pid) die('usage: stockgame player <pid>');
  const { api } = await makeApi(flags);
  const data: PlayerData = await api.player(pid);
  if (flags.json) {
    printJson(data);
    return;
  }
  console.log(`player: ${data.player.name} (#${data.player.id}) followers=${data.player.followers}`);
  console.log(`following: ${data.following.map((p) => p.name).join(', ') || '-'}`);
  console.log(`followers: ${data.followers.map((p) => p.name).join(', ') || '-'}`);
  console.log('funds:');
  for (const [fid, fname] of data.funds ?? []) console.log(`  #${fid} ${fname}`);
  if (data.activity?.length) {
    console.log('\nactivity:');
    for (const a of data.activity.slice(0, 15)) {
      const c = a.contents;
      console.log(
        `  ${ts(a.timeUtc)}  ${c.type}${c.fname ? ` ${c.fname}` : ''}${c.targetPlayer ? ` -> ${c.targetPlayer.name}` : ''}`,
      );
    }
  }
}

async function cmdActivity(flags: Flags): Promise<void> {
  const { api } = await makeApi(flags);
  const feed = (await api.privateActivity()) as Array<{
    timeUtc: number;
    contents: { type: string; player?: { name: string }; fname?: string; targetPlayer?: { name: string } };
  }>;
  if (flags.json) {
    printJson(feed);
    return;
  }
  for (const a of (feed ?? []).slice(0, 40)) {
    const c = a.contents;
    console.log(
      `${ts(a.timeUtc)}  ${c.type.padEnd(8)} ${c.player?.name ?? ''} ${c.fname ?? ''}${c.targetPlayer ? ` -> ${c.targetPlayer.name}` : ''}`,
    );
  }
}

async function cmdStocks(flags: Flags): Promise<void> {
  const { api } = await makeApi(flags);
  const { overview, traded } = await api.universe();
  let stocks = Object.values(overview?.stocks ?? {}).filter((s) => traded?.[s.eid]);
  if (flags.search) {
    const q = String(flags.search).toLowerCase();
    stocks = stocks.filter(
      (s) => s.ticker.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q),
    );
  }
  if (flags.json) {
    printJson(stocks);
    return;
  }
  stocks.sort((a, b) => a.ticker.localeCompare(b.ticker));
  console.log(
    table(
      ['eid', 'ticker', 'name', 'exchange', 'ccy'],
      stocks.map((s) => [
        s.eid,
        s.ticker,
        s.displayName,
        overview.exchanges?.[String(s.exchangeId)]?.name ?? String(s.exchangeId),
        s.currency ?? '',
      ]),
    ),
  );
  console.log(`\n${stocks.length} tradable instruments`);
}

async function cmdInvites(flags: Flags): Promise<void> {
  const { api } = await makeApi(flags);
  const negs = await api.playerNegotiations();
  if (flags.json) {
    printJson(negs);
    return;
  }
  const rows = (negs?.playerNegotiationsWithLeagues ?? []).map((n) => [
    n.lid,
    n.lname,
    n.fname,
    n.fdecision,
    n.ldecision,
    ts(n.updated),
  ]);
  console.log(table(['lid', 'league', 'fund', 'fund says', 'league says', 'updated'], rows));
}

async function cmdRequests(flags: Flags): Promise<void> {
  const lid = pos(flags)[0];
  if (!lid) die('usage: stockgame requests <lid>');
  const { api } = await makeApi(flags);
  const negs = (await api.leagueNegotiations(lid)) as {
    leagueNegotiationsWithFunds?: Array<Record<string, never>>;
    negotiations?: Array<Record<string, never>>;
  };
  if (flags.json) {
    printJson(negs);
    return;
  }
  const list = (negs?.leagueNegotiationsWithFunds ?? negs?.negotiations ?? []) as unknown as Array<
    Record<string, string | number>
  >;
  const rows = list.map((n) => [
    String(n.lid ?? lid),
    String(n.lname ?? ''),
    String(n.fid ?? ''),
    String(n.fname ?? ''),
    String(n.fdecision ?? ''),
    String(n.ldecision ?? ''),
  ]);
  console.log(table(['lid', 'league', 'fid', 'fund', 'fund says', 'league says'], rows));
}

// ---- writes --------------------------------------------------------------

type Order = Record<string, number>;

function parseOrderFromFlags(flags: Flags, currentOrder: Order): Order {
  if (flags.file) return JSON.parse(fs.readFileSync(String(flags.file), 'utf8')) as Order;
  if (flags.current) return { ...currentOrder };
  const set = flags.set;
  if (typeof set !== 'string') die('provide picks via --set "S4=11,S2=8" or --file picks.json');
  try {
    return parseOrderSpec(set);
  } catch (err) {
    die((err as Error).message);
  }
}

async function cmdReweight(flags: Flags): Promise<void> {
  const { api } = await makeApi(flags);
  const { fid, secret } = await currentFund(api, flags);
  const current = (await pulseViaSocket.fetchFund(fid, secret)).order ?? {};
  const order = parseOrderFromFlags(flags, current);
  const { errors, sum } = validateOrder(order);

  if (flags['dry-run'] && flags.json) {
    printJson({ fid, order, sum, errors });
    return;
  }
  console.log(`fund #${fid}  picks=${Object.keys(order).length}  invested=${sum}%`);
  console.log(JSON.stringify(order));
  if (errors.length) {
    console.log('\nrule warnings:');
    for (const e of errors) console.log(`  - ${e}`);
    if (!flags['allow-invalid']) die('order violates game rules (use --allow-invalid to force)');
  }
  if (flags['dry-run']) {
    console.log('\n(dry run, nothing sent)');
    return;
  }

  const res = await api.reweight(fid, order);
  if (flags.json) {
    printJson(res);
    return;
  }
  console.log(`\nsaved. server said: ${JSON.stringify(res)}`);
}

async function cmdCancelReweight(flags: Flags): Promise<void> {
  const { api } = await makeApi(flags);
  const { fid } = await currentFund(api, flags);
  const res = await api.cancelReweight(fid);
  console.log(flags.json ? JSON.stringify(res, null, 2) : `cancelled scheduled reweight for fund #${fid}: ${JSON.stringify(res)}`);
}

async function cmdFollow(flags: Flags, on: boolean): Promise<void> {
  const pid = pos(flags)[0];
  if (!pid) die(`usage: stockgame ${on ? 'follow' : 'unfollow'} <pid>`);
  const { api } = await makeApi(flags);
  const res = on ? await api.follow(pid) : await api.unfollow(pid);
  console.log(flags.json ? JSON.stringify(res, null, 2) : `${on ? 'followed' : 'unfollowed'} player #${pid}`);
}

async function cmdCreateLeague(flags: Flags): Promise<void> {
  const name = pos(flags).join(' ');
  if (!name) die('usage: stockgame create-league <name>');
  const { api } = await makeApi(flags);
  const res = await api.createLeague(name);
  console.log(flags.json ? JSON.stringify(res, null, 2) : `create-league "${name}": ${JSON.stringify(res)}`);
}

async function cmdDeleteLeague(flags: Flags): Promise<void> {
  const lid = pos(flags)[0];
  if (!lid) die('usage: stockgame delete-league <lid> --yes');
  if (!flags.yes) die('refusing to delete a league without --yes');
  const { api } = await makeApi(flags);
  const res = await api.deleteLeague(lid);
  console.log(flags.json ? JSON.stringify(res, null, 2) : `delete-league #${lid}: ${JSON.stringify(res)}`);
}

async function cmdFundAction(flags: Flags, kind: string): Promise<void> {
  const lid = pos(flags)[0];
  if (!lid) die(`usage: stockgame ${kind} <lid> --fund <fid>`);
  const { api } = await makeApi(flags);
  const { fid } = await currentFund(api, flags);
  const actions: Record<string, () => Promise<unknown>> = {
    'fund-join': () => api.fundJoinLeague(fid, lid),
    'fund-request': () => api.fundRequestToJoin(fid, lid),
    'fund-leave': () => api.fundLeaveLeague(fid, lid),
    'fund-reject': () => api.fundRejectInvite(fid, lid),
    'fund-cancel': () => api.fundCancelRequest(fid, lid),
  };
  const res = await actions[kind]?.();
  console.log(flags.json ? JSON.stringify(res, null, 2) : `${kind} league #${lid} fund #${fid}: ${JSON.stringify(res)}`);
}

async function cmdLeagueAction(flags: Flags, kind: string): Promise<void> {
  const lid = pos(flags)[0];
  const fid = pos(flags)[1];
  if (!lid || !fid) die(`usage: stockgame ${kind} <lid> <fid>`);
  const { api } = await makeApi(flags);
  const actions: Record<string, () => Promise<unknown>> = {
    'league-invite': () => api.leagueInviteFund(lid, fid),
    'league-join': () => api.leagueJoinFund(lid, fid),
    'league-reject': () => api.leagueRejectFund(lid, fid),
    'league-reset': () => api.leagueResetDecision(lid, fid),
  };
  const res = await actions[kind]?.();
  console.log(flags.json ? JSON.stringify(res, null, 2) : `${kind} lid=${lid} fid=${fid}: ${JSON.stringify(res)}`);
}

async function cmdNegotiate(flags: Flags): Promise<void> {
  const lid = pos(flags)[0];
  const fid = pos(flags)[1];
  if (!lid || !fid) die('usage: stockgame negotiate <lid> <fid> --accept|--reject');
  if (!flags.accept && !flags.reject) die('choose --accept or --reject');
  const { api } = await makeApi(flags);
  const accept = Boolean(flags.accept);
  const res = await api.fundNegotiateDecision(lid, fid, accept);
  console.log(flags.json ? JSON.stringify(res, null, 2) : `negotiate lid=${lid} fid=${fid} accept=${accept}: ${JSON.stringify(res)}`);
}

async function cmdRaw(flags: Flags): Promise<void> {
  const path = pos(flags)[0];
  if (!path) die('usage: stockgame raw <path> [--method POST] [--data <json>]');
  const { api } = await makeApi(flags);
  const method = String(flags.method ?? (flags.data ? 'POST' : 'GET')).toUpperCase();
  let data: unknown;
  if (flags.data) {
    try {
      data = JSON.parse(String(flags.data));
    } catch {
      die('--data must be valid JSON');
    }
  }
  const res = method === 'GET' ? await api.get(path) : await api.post(path, data ?? {});
  printJson(res);
}

async function cmdServe(flags: Flags): Promise<void> {
  const mod = await import('./serve.js');
  const noBrowser = Boolean(flags['no-browser']) || process.env.STOCKGAME_NO_BROWSER === '1';
  await mod.startServer({
    host: str(flags.host) ?? process.env.STOCKGAME_HOST ?? '127.0.0.1',
    port: flags.port ? Number(flags.port) : Number(process.env.STOCKGAME_PORT ?? 8787),
    cookie: str(flags.cookie) ?? process.env.STOCKGAME_COOKIE,
    token: str(flags.token) ?? process.env.STOCKGAME_TOKEN,
    devtoolsPort: Number(process.env.STOCKGAME_DEVTOOLS_PORT ?? 9222),
    allowBrowser: !noBrowser,
  });
}

// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  if (flags.h || flags.help || _.length === 0) {
    console.log(HELP.trimEnd());
    return;
  }
  const cmd = _[0] as string;
  (flags as Record<string, unknown>)._ = _.slice(1);

  const commands: Record<string, (f: Flags) => Promise<void>> = {
    auth: cmdAuth,
    login: cmdAuth,
    whoami: cmdWhoami,
    config: async () => cmdConfig(),
    serve: cmdServe,
    portfolio: cmdPortfolio,
    funds: cmdPortfolio,
    leagues: cmdLeagues,
    league: cmdLeague,
    player: cmdPlayer,
    activity: cmdActivity,
    stocks: cmdStocks,
    invites: cmdInvites,
    requests: cmdRequests,
    reweight: cmdReweight,
    save: cmdReweight,
    'cancel-reweight': cmdCancelReweight,
    follow: (f) => cmdFollow(f, true),
    unfollow: (f) => cmdFollow(f, false),
    'create-league': cmdCreateLeague,
    'delete-league': cmdDeleteLeague,
    'fund-join': (f) => cmdFundAction(f, 'fund-join'),
    'fund-request': (f) => cmdFundAction(f, 'fund-request'),
    'fund-leave': (f) => cmdFundAction(f, 'fund-leave'),
    'fund-reject': (f) => cmdFundAction(f, 'fund-reject'),
    'fund-cancel': (f) => cmdFundAction(f, 'fund-cancel'),
    'league-invite': (f) => cmdLeagueAction(f, 'league-invite'),
    'league-join': (f) => cmdLeagueAction(f, 'league-join'),
    'league-reject': (f) => cmdLeagueAction(f, 'league-reject'),
    'league-reset': (f) => cmdLeagueAction(f, 'league-reset'),
    negotiate: cmdNegotiate,
    raw: cmdRaw,
    logout: async () => {
      store.clear();
      console.log('session cleared');
    },
  };

  const run = commands[cmd];
  if (!run) die(`unknown command "${cmd}" (try --help)`);
  try {
    await run(flags);
  } catch (err) {
    if (err instanceof ApiError) die(`${err.message}${err.body ? ` :: ${JSON.stringify(err.body)}` : ''}`);
    die((err as Error).message ?? String(err));
  }
}

main();
