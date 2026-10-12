#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs';
import { Api, ApiError } from './api.js';
import { resolveAuth } from './auth.js';
import { fundState } from './pulse.js';
import { RULES, GICS, readSession, clearSession, SESSION_FILE } from './config.js';
import { money, signedPct, table, ts, printJson } from './format.js';

const HELP = `stockgame - drive the FT Stock Picking Game from the CLI

Usage: stockgame <command> [options]

Connection
  auth [--refresh]            Resolve/refresh the session (uses the logged-in browser)
  whoami                      Show user, player, funds and token status
  config                      Show config paths

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
  --cookie <c>  Use an FT session cookie directly
  --port <n>    DevTools port of the logged-in browser (default 9222)
  -h, --help    Show this help
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq > 0) out.flags[body.slice(0, eq)] = body.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.flags[body] = argv[++i];
      else out.flags[body] = true;
    } else if (/^-[a-z]$/.test(a)) {
      const k = a.slice(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

async function makeApi(flags) {
  const { token, claims, source } = await resolveAuth({
    token: typeof flags.token === 'string' ? flags.token : undefined,
    cookie: typeof flags.cookie === 'string' ? flags.cookie : undefined,
    port: flags.port ? Number(flags.port) : 9222,
    refresh: Boolean(flags.refresh),
  });
  return { api: new Api(token), claims, source };
}

async function currentFund(api, flags) {
  const user = await api.userdata();
  const funds = user?.funds ?? [];
  if (funds.length === 0) die('no fund on this account');
  let fid = flags.fund ? Number(flags.fund) : funds[0][0];
  const fund = funds.find((f) => f[0] === fid);
  if (!fund) die(`fund ${fid} not found on this account`);
  return { user, fund, fid, secret: user.secret };
}

function eidName(universe, eid) {
  const stock = universe?.overview?.stocks?.[eid.replace(/^S/, '')] ?? null;
  // stocks are keyed by numeric id; find by eid as fallback
  if (stock) return `${stock.ticker} (${stock.displayName})`;
  const found = Object.values(universe?.overview?.stocks ?? {}).find((s) => s.eid === eid);
  return found ? `${found.ticker} (${found.displayName})` : eid;
}

function stockByEid(universe, eid) {
  return Object.values(universe?.overview?.stocks ?? {}).find((s) => s.eid === eid) ?? null;
}

// --------------------------------------------------------------------------

async function cmdAuth(flags) {
  const { token, claims, source } = await makeApi(flags);
  const exp = claims?.exp ? new Date(claims.exp * 1000).toISOString() : '-';
  if (flags.json) return printJson({ source, token, claims });
  console.log(`auth source : ${source}`);
  console.log(`token exp   : ${exp}`);
  console.log(`extId       : ${claims?.extId ?? '-'}`);
  console.log(`userId      : ${claims?.uid ?? '-'}`);
}

async function cmdWhoami(flags) {
  const { api, claims, source } = await makeApi(flags);
  const user = await api.userdata();
  if (flags.json) return printJson({ source, claims, user });
  console.log(`auth        : ${source}`);
  console.log(`user        : ${user?.player?.name ?? '-'} (player #${user?.player?.id})  userId ${user?.userId}`);
  console.log(`active      : ${user?.active}`);
  console.log(`secret      : ${user?.secret ?? '-'}`);
  console.log('\nfunds:');
  for (const [fid, fname, active, leagues] of user?.funds ?? []) {
    console.log(`  #${fid} ${fname}${active ? ' (active)' : ''}`);
    for (const [lid, lname] of leagues ?? []) console.log(`      league #${lid} ${lname}`);
  }
}

function cmdConfig() {
  console.log(`session file: ${SESSION_FILE}`);
  const s = readSession();
  console.log(`session     : ${s ? `present (updated ${s.updatedAt})` : 'none'}`);
}

async function cmdPortfolio(flags) {
  const { api } = await makeApi(flags);
  const { user, fid, secret } = await currentFund(api, flags);
  const [state, universe] = await Promise.all([fundState(fid, secret), api.universe()]);
  const picks = Object.entries(state.order ?? {}).sort((a, b) => b[1] - a[1]);
  const scheduled = state.next_opt && Object.keys(state.next_opt).length ? state.next_opt : null;

  if (flags.json) return printJson({ fid, state, universe: undefined });

  console.log(`fund   : ${user.funds.find((f) => f[0] === fid)[1]} (#${fid})`);
  console.log(`value  : ${money(state.v, 2)}   base: ${money(state.b, 2)}   ${state.reweighed ? '(reweight scheduled)' : ''}`);
  const rows = picks.map(([eid, pct]) => {
    const s = stockByEid(universe, eid);
    const chg = state.sState?.[eid]?.[1];
    return [eid, s?.ticker ?? eid, s?.displayName ?? '', `${pct}%`, chg == null ? '-' : signedPct(chg)];
  });
  console.log('\n' + table(['eid', 'ticker', 'name', 'alloc', 'day chg'], rows));

  const cash = 100 - picks.reduce((a, [, p]) => a + p, 0);
  console.log(`\ninvested: ${100 - cash}%   cash: ${cash}%`);

  if (scheduled) {
    const changes = [];
    const ids = new Set([...Object.keys(state.order ?? {}), ...Object.keys(scheduled)]);
    for (const eid of ids) {
      const now = state.order?.[eid] ?? 0;
      const next = scheduled[eid] ?? 0;
      if (now !== next) changes.push([eid, `${now}%`, `${next}%`, next === 0 ? 'sell' : now === 0 ? 'buy' : 'adjust']);
    }
    console.log('\nscheduled changes (next market open):');
    console.log(table(['eid', 'now', 'next', 'action'], changes));
  }

  const exposure = new Map();
  for (const [eid, pct] of picks) {
    const s = stockByEid(universe, eid);
    const key = s ? GICS[Number(s.gics)] ?? `gics ${s.gics}` : 'unknown';
    exposure.set(key, (exposure.get(key) ?? 0) + pct);
  }
  console.log('\nexposure:');
  for (const [k, v] of [...exposure.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}%`);
  if (cash > 0) console.log(`  Cash: ${cash}%`);
}

async function cmdLeagues(flags) {
  const { api } = await makeApi(flags);
  const user = await api.userdata();
  const mine = new Set();
  for (const [, , , leagues] of user?.funds ?? []) for (const [lid] of leagues ?? []) mine.add(lid);

  const all = await api.leagues();
  let rows = (all ?? []).map(([lid, name, a, b]) => [lid, name, a, b, mine.has(lid) ? '*' : '']);
  if (!flags.all) rows = rows.filter((r) => r[4] === '*');
  if (flags.json) return printJson(all);
  console.log(table(['lid', 'name', 'members?', 'x', 'mine'], rows));
}

async function cmdLeague(flags) {
  const lid = Number(flags._[0]);
  if (!lid) die('usage: stockgame league <lid>');
  const { api } = await makeApi(flags);
  const [page, funds, results] = await Promise.all([
    api.leaguePage(lid),
    api.leagueFunds(lid),
    api.leagueFundResults(lid).catch(() => null),
  ]);
  if (flags.json) return printJson({ page, funds, results });
  console.log(`league: ${funds?.name ?? page?.lname} (#${lid})`);
  console.log(`owned: ${page?.owned}  canJoin: ${page?.canJoin}  canLeave: ${page?.canLeave}`);
  const rows = (funds?.funds ?? []).map(([fid, fname, active, pid, pname]) => [
    fid,
    fname,
    pname,
    money(funds?.ress?.[fid] ?? null, 2),
  ]);
  console.log('\n' + table(['fid', 'fund', 'player', 'value'], rows));
  if (results) {
    console.log('\nresults:');
    console.log(printSafe(results));
  }
}

function printSafe(v) {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

async function cmdPlayer(flags) {
  const pid = flags._[0];
  if (!pid) die('usage: stockgame player <pid>');
  const { api } = await makeApi(flags);
  const data = await api.player(pid);
  if (flags.json) return printJson(data);
  console.log(`player: ${data.player.name} (#${data.player.id}) followers=${data.player.followers}`);
  console.log(`following: ${data.following.map((p) => p.name).join(', ') || '-'}`);
  console.log(`followers: ${data.followers.map((p) => p.name).join(', ') || '-'}`);
  console.log('funds:');
  for (const [fid, fname, active, leagues] of data.funds ?? []) {
    console.log(`  #${fid} ${fname}`);
  }
  if (data.activity?.length) {
    console.log('\nactivity:');
    for (const a of data.activity.slice(0, 15)) {
      console.log(`  ${ts(a.timeUtc)}  ${a.contents.type}${a.contents.fname ? ` ${a.contents.fname}` : ''}${a.contents.targetPlayer ? ` -> ${a.contents.targetPlayer.name}` : ''}`);
    }
  }
}

async function cmdActivity(flags) {
  const { api } = await makeApi(flags);
  const feed = await api.privateActivity();
  if (flags.json) return printJson(feed);
  for (const a of (feed ?? []).slice(0, 40)) {
    const c = a.contents;
    console.log(`${ts(a.timeUtc)}  ${c.type.padEnd(8)} ${c.player?.name ?? ''} ${c.fname ?? ''}${c.targetPlayer ? ` -> ${c.targetPlayer.name}` : ''}`);
  }
}

async function cmdStocks(flags) {
  const { api } = await makeApi(flags);
  const { overview, traded } = await api.universe();
  let stocks = Object.values(overview?.stocks ?? {}).filter((s) => traded?.[s.eid]);
  if (flags.search) {
    const q = String(flags.search).toLowerCase();
    stocks = stocks.filter((s) => s.ticker.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q));
  }
  if (flags.json) return printJson(stocks);
  stocks.sort((a, b) => a.ticker.localeCompare(b.ticker));
  console.log(table(['eid', 'ticker', 'name', 'exchange', 'ccy'], stocks.map((s) => [
    s.eid, s.ticker, s.displayName, overview.exchanges?.[s.exchangeId]?.name ?? s.exchangeId, s.currency ?? '',
  ])));
  console.log(`\n${stocks.length} tradable instruments`);
}

async function cmdInvites(flags) {
  const { api } = await makeApi(flags);
  const negs = await api.playerNegotiations();
  if (flags.json) return printJson(negs);
  const rows = (negs?.playerNegotiationsWithLeagues ?? []).map((n) => [
    n.lid, n.lname, n.fname, n.fdecision, n.ldecision, ts(n.updated),
  ]);
  console.log(table(['lid', 'league', 'fund', 'fund says', 'league says', 'updated'], rows));
}

async function cmdRequests(flags) {
  const lid = flags._[0];
  if (!lid) die('usage: stockgame requests <lid>');
  const { api } = await makeApi(flags);
  const negs = await api.leagueNegotiations(lid);
  if (flags.json) return printJson(negs);
  const rows = (negs?.leagueNegotiationsWithFunds ?? negs?.negotiations ?? []).map((n) => [
    n.lid ?? lid, n.lname ?? '', n.fid, n.fname, n.fdecision, n.ldecision,
  ]);
  console.log(table(['lid', 'league', 'fid', 'fund', 'fund says', 'league says'], rows));
}

// ---- writes --------------------------------------------------------------

function parseOrderFromFlags(flags, currentOrder) {
  if (flags.file) {
    return JSON.parse(fs.readFileSync(String(flags.file), 'utf8'));
  }
  if (flags.current) return { ...currentOrder };
  const set = flags.set;
  if (typeof set !== 'string') die('provide picks via --set "S4=11,S2=8" or --file picks.json');
  const order = {};
  for (const part of set.split(',')) {
    const [eid, pct] = part.split('=').map((s) => s.trim());
    if (!eid || pct === undefined) die(`bad pick "${part}" (expected eid=pct)`);
    order[/^S\d+$/.test(eid) ? eid : `S${eid}`] = Number(pct);
  }
  return order;
}

function validateOrder(order) {
  const entries = Object.entries(order);
  const errors = [];
  const sum = entries.reduce((a, [, p]) => a + Number(p), 0);
  if (entries.length < RULES.minPicks) errors.push(`too few picks: ${entries.length} < ${RULES.minPicks}`);
  if (entries.length > RULES.maxPicks) errors.push(`too many picks: ${entries.length} > ${RULES.maxPicks}`);
  for (const [eid, pct] of entries) {
    if (pct < RULES.minPickPct || pct > RULES.maxPickPct) errors.push(`${eid}: ${pct}% outside ${RULES.minPickPct}-${RULES.maxPickPct}%`);
  }
  if (sum < RULES.minInvestedPct) errors.push(`invested ${sum}% < ${RULES.minInvestedPct}%`);
  if (sum > RULES.maxInvestedPct) errors.push(`invested ${sum}% > ${RULES.maxInvestedPct}%`);
  return { errors, sum };
}

async function cmdReweight(flags) {
  const { api } = await makeApi(flags);
  const { fid, secret } = await currentFund(api, flags);
  const current = (await fundState(fid, secret)).order ?? {};
  const order = parseOrderFromFlags(flags, current);
  const { errors, sum } = validateOrder(order);

  if (flags.json && flags['dry-run']) return printJson({ fid, order, sum, errors });
  console.log(`fund #${fid}  picks=${Object.keys(order).length}  invested=${sum}%`);
  console.log(JSON.stringify(order, null, 0));
  if (errors.length) {
    console.log('\nrule warnings:');
    for (const e of errors) console.log(`  - ${e}`);
    if (!flags['allow-invalid']) die('order violates game rules (use --allow-invalid to force)');
  }
  if (flags['dry-run']) return console.log('\n(dry run, nothing sent)');

  const res = await api.reweight(fid, order);
  if (flags.json) return printJson(res);
  console.log(`\nsaved. server said: ${JSON.stringify(res)}`);
}

async function cmdCancelReweight(flags) {
  const { api } = await makeApi(flags);
  const { fid } = await currentFund(api, flags);
  const res = await api.cancelReweight(fid);
  console.log(flags.json ? printSafe(res) : `cancelled scheduled reweight for fund #${fid}: ${JSON.stringify(res)}`);
}

async function cmdFollow(flags, on) {
  const pid = flags._[0];
  if (!pid) die(`usage: stockgame ${on ? 'follow' : 'unfollow'} <pid>`);
  const { api } = await makeApi(flags);
  const res = on ? await api.follow(pid) : await api.unfollow(pid);
  console.log(flags.json ? printSafe(res) : `${on ? 'followed' : 'unfollowed'} player #${pid}`);
}

async function cmdCreateLeague(flags) {
  const name = flags._.join(' ');
  if (!name) die('usage: stockgame create-league <name>');
  const { api } = await makeApi(flags);
  const res = await api.createLeague(name);
  console.log(flags.json ? printSafe(res) : `create-league "${name}": ${JSON.stringify(res)}`);
}

async function cmdDeleteLeague(flags) {
  const lid = flags._[0];
  if (!lid) die('usage: stockgame delete-league <lid> --yes');
  if (!flags.yes) die('refusing to delete a league without --yes');
  const { api } = await makeApi(flags);
  const res = await api.deleteLeague(lid);
  console.log(flags.json ? printSafe(res) : `delete-league #${lid}: ${JSON.stringify(res)}`);
}

function lidFid(flags, usage) {
  const lid = flags._[0];
  if (!lid) die(usage);
  return lid;
}

async function cmdFundAction(flags, kind) {
  const lid = lidFid(flags, `usage: stockgame ${kind} <lid> --fund <fid>`);
  const { api } = await makeApi(flags);
  const { fid } = await currentFund(api, flags);
  const map = {
    'fund-join': () => api.fundJoinLeague(fid, lid),
    'fund-request': () => api.fundRequestToJoin(fid, lid),
    'fund-leave': () => api.fundLeaveLeague(fid, lid),
    'fund-reject': () => api.fundRejectInvite(fid, lid),
    'fund-cancel': () => api.fundCancelRequest(fid, lid),
  };
  const res = await map[kind]();
  console.log(flags.json ? printSafe(res) : `${kind} league #${lid} fund #${fid}: ${JSON.stringify(res)}`);
}

async function cmdLeagueAction(flags, kind) {
  const lid = flags._[0];
  const fid = flags._[1];
  if (!lid || !fid) die(`usage: stockgame ${kind} <lid> <fid>`);
  const { api } = await makeApi(flags);
  const map = {
    'league-invite': () => api.leagueInviteFund(lid, fid),
    'league-join': () => api.leagueJoinFund(lid, fid),
    'league-reject': () => api.leagueRejectFund(lid, fid),
    'league-reset': () => api.leagueResetDecision(lid, fid),
  };
  const res = await map[kind]();
  console.log(flags.json ? printSafe(res) : `${kind} lid=${lid} fid=${fid}: ${JSON.stringify(res)}`);
}

async function cmdNegotiate(flags) {
  const lid = flags._[0];
  const fid = flags._[1];
  if (!lid || !fid) die('usage: stockgame negotiate <lid> <fid> --accept|--reject');
  if (!flags.accept && !flags.reject) die('choose --accept or --reject');
  const { api } = await makeApi(flags);
  const accept = Boolean(flags.accept);
  const res = await api.fundNegotiateDecision(lid, fid, accept);
  console.log(flags.json ? printSafe(res) : `negotiate lid=${lid} fid=${fid} accept=${accept}: ${JSON.stringify(res)}`);
}

async function cmdRaw(flags) {
  const path = flags._[0];
  if (!path) die('usage: stockgame raw <path> [--method POST] [--data <json>]');
  const { api } = await makeApi(flags);
  const method = String(flags.method ?? (flags.data ? 'POST' : 'GET')).toUpperCase();
  let data;
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

// --------------------------------------------------------------------------

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  if (flags.h || flags.help || _.length === 0) return console.log(HELP.trimEnd());
  const cmd = _[0];
  flags._ = _.slice(1);

  const table_ = {
    auth: cmdAuth,
    login: cmdAuth,
    whoami: cmdWhoami,
    config: () => cmdConfig(),
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
    logout: () => {
      clearSession();
      console.log('session cleared');
    },
  };

  const run = table_[cmd];
  if (!run) die(`unknown command "${cmd}" (try --help)`);
  try {
    await run(flags);
  } catch (err) {
    if (err instanceof ApiError) die(`${err.message}${err.body ? ` :: ${JSON.stringify(err.body)}` : ''}`);
    die(err.message ?? String(err));
  }
}

main();
