# ft-stockgame-cli

A **TypeScript** tool for the **FT Stock Picking Game**
(`https://stockpickinggame.ft.com/`) that exposes the game's backend three ways:

1. a **CLI** that mirrors the web GUI,
2. a **Hono HTTP server**, and
3. an **MCP server** (Streamable HTTP) so an agent can drive the game as tools,

plus a **skills.sh** skill that teaches coding agents how to use it. It reuses the
session of a browser you are **already logged into** — no password is ever handled.

The core uses Web-standard APIs only (`fetch`, `WebSocket`, `crypto`), so it runs on
**Node ≥ 22, Bun and Deno**; the only runtime dependencies are `hono` and
`@hono/node-server` (the latter only on Node).

---

## Disclaimer

- **Unofficial / not affiliated.** This project is not made by, endorsed by, or
  connected to the Financial Times or Norkon Fantasy Funds. All trademarks belong
  to their owners.
- **Reverse-engineered.** The client talks to private, undocumented endpoints that
  were derived by inspecting the public site. They can change or disappear at any
  time and **will break this tool**.
- **Personal / educational use.** Use it only with your own account, at your own
  risk. Automated access may violate the site's terms of service — you are
  responsible for how you use it.
- **Writes are real.** Commands like `reweight` and `delete-league` change your
  actual game state. There is no undo from the tool.
- **No warranty.** Provided as-is, without any warranty of correctness or fitness.
- **Keep credentials out of git.** `~/.config/stockgame/session.json` holds a
  session cookie + JWT. It lives outside the repo and is git-ignored.

---

## Requirements

- **Node ≥ 22** (or Bun ≥ 1.1 / Deno ≥ 2 — the code is runtime-agnostic; Node is what
  has been verified).
- A Chromium-family browser (tested with **Helium**) where you are logged in to
  `ft.com`, started with remote debugging enabled.

### Enabling remote debugging

Close the browser, then relaunch it with a debug port. Your login persists.

```powershell
# Windows example (Helium)
& "C:\Program Files\imput\Helium\Application\chrome.exe" --remote-debugging-port=9222
```

Check it: <http://127.0.0.1:9222/json/version> should return JSON.

## Install & build

```bash
npm install         # installs deps and runs `tsc` (prepare) into dist/
npm run build       # explicit build
npm link            # optional: exposes the `stockgame` command
```

Run without building, via tsx: `npm run dev -- whoami`.

## Usage (CLI)

```bash
node dist/node/cli.js whoami          # pulls the session from the browser on :9222
node dist/node/cli.js portfolio       # live value, picks, scheduled trades, exposure
node dist/node/cli.js leagues         # your leagues
node dist/node/cli.js league 640      # league page, funds, returns, history
node dist/node/cli.js stocks --search nvidia
node dist/node/cli.js reweight --fund 11479 --set "S4=11,S2=8,S40=6,S108=8,S5=11,S13=5,S687=8,S6=5,S3=5,S15=5,S27=5" --dry-run
node dist/node/cli.js --help
```

Global flags: `--json`, `--token <jwt>`, `--cookie <c>`, `--no-browser`, `--port <n>`, `--refresh`.

### Session model — refreshing without the browser

The root credential is the FT session cookie (`FTSession_s`); the game's JWT is
derived from it via `/v1/user/initialize`. There is **no** JWT refresh token and
the FT session cannot be extended server-side, so:

- The cookie is cached in `~/.config/stockgame/session.json` on first use.
- After that, **every run renews the JWT by itself** — cached cookie →
  `initialize` → fresh 7-day JWT — with **zero browser involvement**.
- `--no-browser` (or `STOCKGAME_NO_BROWSER=1`) enforces this: the CLI never opens a
  DevTools connection and fails loudly instead.
- The browser is only needed to **bootstrap** a cookie (once) or after the FT
  session itself expires (`rememberMe` sessions last ~6 months; your `expiryTime`
  is returned by `session-next.ft.com`).

Bootstrap options:

1. `--cookie "FTSession_s=..."` — paste it once; nothing else ever touches a browser.
2. A browser started with `--remote-debugging-port=9222` (read over DevTools).

So the practical answer to "can it refresh by itself?": **yes** — one cached cookie
keeps the CLI self-sufficient for the lifetime of the FT session.

---

## HTTP + MCP server

The same core is served by a [Hono](https://hono.dev) app.

```bash
node dist/node/cli.js serve --host 127.0.0.1 --port 8787
# or: npm run serve            (via tsx)
# or: STOCKGAME_PORT=8787 node dist/server/serve.js
```

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness + version |
| POST | `/mcp` | MCP JSON-RPC (Streamable HTTP; mints `Mcp-Session-Id`) |
| GET | `/mcp` | SSE stream (server → client keep-alive) |
| DELETE | `/mcp` | end an MCP session |

Server flags: `--host`, `--port`, `--cookie`, `--token`, `--no-browser`, `--devtools-port`
(or `STOCKGAME_HOST` / `STOCKGAME_PORT` / `STOCKGAME_COOKIE` / `STOCKGAME_TOKEN`).

### MCP tools (26)

- **Read**: `whoami`, `portfolio`, `list_leagues`, `league_details`, `player_profile`,
  `search_players`, `activity_feed`, `stock_universe`, `list_negotiations`
- **Write**: `save_picks` (rule-validated, supports `dryRun`), `cancel_reweight`,
  `follow`, `unfollow`, `create_league`, `delete_league` (needs `confirm`),
  `join_league`, `leave_league`, `request_join`, `reject_invite`, `cancel_request`,
  `league_invite`, `league_join`, `league_reject`, `league_reset`, `negotiate`
- **Escape hatch**: `raw_request`

### Connect an MCP client

```bash
# Claude Code
claude mcp add --transport http stockgame http://127.0.0.1:8787/mcp
```

```jsonc
// generic Streamable HTTP MCP client config
{ "mcpServers": { "stockgame": { "type": "http", "url": "http://127.0.0.1:8787/mcp" } } }
```

The server authenticates lazily on the first tool call using the same session model
(cached cookie → JWT), so `--no-browser` applies here too.

### Deploy to Cloudflare Workers

The Worker entry (`src/worker.ts`) serves the same Hono app. Workers has no filesystem
and no browser, so:

- the FT cookie is a **secret** (`STOCKGAME_COOKIE`) — copy `FTSession_s=...` from your
  logged-in browser once, and rotate it when the FT session expires (~6 months);
- the JWT is memoised in isolate memory — **no KV and no Durable Objects needed**;
- the realtime feed uses the **plain-HTTP Pulse endpoint** (`POST /Pulse/Request/`), so
  no websocket is required (and Workers can't use `new WebSocket()` anyway).

```bash
npx wrangler secret put STOCKGAME_COOKIE      # "FTSession_s=..."
npx wrangler secret put STOCKGAME_MCP_TOKEN   # bearer gate for /mcp (recommended)
npx wrangler deploy
```

Local run on the real Workers runtime (workerd): put the two values in `.dev.vars`
(git-ignored) and run `npm run dev:worker`.

Then point an MCP client / ChatGPT connector at
`https://<worker>.<account>.workers.dev/mcp` with `Authorization: Bearer <token>`.

> Anyone with the URL **and** the token can act on your account. Keep the token secret,
> and rotate `STOCKGAME_COOKIE` when `session-next.ft.com` reports your session expired.

---

## How it works

The site is a Nuxt SPA backed by Norkon Fantasy Funds. Three mechanisms matter:

1. **Auth.** `GET /api/v1/user/initialize` is called with the FT session cookie
   (`FTSession_s`) and returns a short-lived JWT. Every other call sends
   `Authorization: Bearer <jwt>`.
2. **REST API** for leagues, funds, players and picks.
3. **Realtime feed** for private fund state — current picks, scheduled picks, value
   and ticks are **not** served over REST. It is available two ways:
   `wss://api.ft-s02-prod.fantasy.norkon.net/Pulse/` (websocket) or
   `POST https://api.ft-s02-prod.fantasy.norkon.net/Pulse/Request/` (plain HTTP — the
   path used on Cloudflare Workers, which cannot use `new WebSocket()`).

The CLI obtains the FT cookie either from a running Chromium browser over the
DevTools protocol (`Storage.getCookies`), from `--cookie`, or from a cached JWT.

### Base URLs

| Thing | Value |
| --- | --- |
| Site | `https://stockpickinggame.ft.com/` |
| API base | `https://api.ft-s02-prod.fantasy.norkon.net/api/` |
| Realtime (ws) | `wss://api.ft-s02-prod.fantasy.norkon.net/Pulse/` |
| Realtime (http) | `POST https://api.ft-s02-prod.fantasy.norkon.net/Pulse/Request/` |
| Session refresh | `https://session-next.ft.com/sessions/s/<FTSession_s>` |

---

## API specification

All REST calls accept/return JSON. `result` wraps successful payloads
(`{"success":true,"result":...}`).

### Auth

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/v1/user/initialize` | – | Needs `Cookie: FTSession_s=...`. Returns `{ result: { jwtToken } }` or `{ result: null }` when logged out. JWT payload: `{ extId, uid, isB2b, isB2c, exp }` (~7 days). |

### Reads

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/fantasyfunds/userdata` | `{ active, userId, player:{id,name,confirmed,followers}, secret, funds:[[fid,fname,active,[[lid,lname]]]] }` |
| GET | `/FantasyFunds/GetLeagues` | `[[lid, lname, a, b], ...]` |
| GET | `/FantasyFunds/GetLeaguePage?leagueId=` | `{ owned, canJoin, canLeave, lname, negs? }` |
| GET | `/FantasyFunds/LeagueFundList?leagueId=` | `{ name, funds:[[fid,fname,active,pid,pname]], ress:{ fid: value } }` |
| GET | `/FantasyFunds/leaguefundresultlist?leagueId=` | Per-fund returns, positions, top history. |
| GET | `/FantasyFunds/PlayerData/{pid}` | `{ player, followers[], following[], activity[], funds[] }` |
| GET | `/FantasyFunds/PlayerBadges?playerId=` | Badge events + totals. |
| GET | `/FantasyFunds/searchplayerfund?term=` | `[{ pid, pname, funds:[{fid,fname}] }]` |
| GET | `/FantasyFunds/GetFundNegotiations?fundId=` | Negotiations for a fund. |
| GET | `/FantasyFunds/PrivateActivity` | Private activity feed. |
| GET | `/FantasyFunds/new-negs/player-meta` | Player's funds + league memberships. |
| GET | `/FantasyFunds/new-negs/player-negotiations` | Pending negotiations (player side). |
| GET | `/FantasyFunds/new-negs/league-negotiations?lid=` | Negotiations for a league (owner side). |
| GET | `/FantasyFunds/new-negs/league-search-to-invite?lid=&term=` | Fund search to invite. |
| GET | `/official-leagues` | Official leagues (often `[]`). |
| GET | `/v1/invest-hubs/overview` | `{ utcTimestamp, exchanges{}, stocks{}, etfs? }` — the instrument universe. |
| GET | `/FantasyFunds/GetAllTradedStocks` | `{ eid: true, ... }` — which instruments are tradable. |
| GET | `/FantasyFunds/historical-fund-performance?fid=` | Historical series (may be `null`). |

### Writes (POST, JSON)

| Path | Body | Does |
| --- | --- | --- |
| `/FantasyFunds/CreateLeague` | `{ leagueName }` | Create league → returns new `leagueId`. |
| `/FantasyFunds/DeleteLeague` | `{ leagueId }` | Delete a league you own. |
| `/FantasyFunds/LeaveLeague` | `{ leagueId, fundId }` | Leave a league. |
| `/FantasyFunds/CreateFund` | `{ fundName, orderMapStr }` | Create another fund. |
| `/FantasyFunds/RegisterPlayerWithFund` | `{ registrationDataStr, orderMapStr }` | Sign up: player + fund + initial picks. |
| `/FantasyFunds/DeleteSelf` | `{}` | Delete your player. |
| `/FantasyFunds/Follow` | `{ playerId }` | Follow a player. |
| `/FantasyFunds/Unfollow` | `{ playerId }` | Unfollow. |
| `/FantasyFunds/ReweighSelectedFund/` | `{ fundId, order }` | Save picks. `order` = `{ eid: pct }`; executes at the next market open. |
| `/FantasyFunds/CancelReweighSelectedFund` | `{ fundId }` | Cancel a scheduled reweight. |
| `/FantasyFunds/FundNegotiateDecision` | `{ leagueId, fundId, accept }` | Fund side of a negotiation. |
| `/FantasyFunds/LeagueNegotiateDecision` | `{ leagueId, fundId, accept }` | League side of a negotiation. |
| `/FantasyFunds/new-negs/do-fund-join-league?fid=&lid=` | – | Join an open league. |
| `/FantasyFunds/new-negs/do-fund-request-to-join-league?fid=&lid=` | – | Request to join a private league. |
| `/FantasyFunds/new-negs/do-fund-leave-league?fid=&lid=` | – | Leave. |
| `/FantasyFunds/new-negs/do-fund-reject-invite?fid=&lid=` | – | Reject an invite. |
| `/FantasyFunds/new-negs/do-fund-cancel-request-to-join?fid=&lid=` | – | Cancel a join request. |
| `/FantasyFunds/new-negs/do-league-invite-fund?fid=&lid=` | – | Owner invites a fund. |
| `/FantasyFunds/new-negs/do-league-join-fund?fid=&lid=` | – | Owner accepts a fund. |
| `/FantasyFunds/new-negs/do-league-reject-fund?fid=&lid=` | – | Owner rejects a fund. |
| `/FantasyFunds/new-negs/do-league-reset-decision?fid=&lid=` | – | Owner resets a decision. |

`orderMapStr` / `order` is always a map of instrument key → percent, e.g.
`{"S4":11,"S2":8}` (the `S<n>` keys come from `invest-hubs/overview`).

### Realtime (websocket)

Connect to `wss://api.ft-s02-prod.fantasy.norkon.net/Pulse/` (note the `/Pulse/`
suffix) with `Origin: https://stockpickinggame.ft.com`, then send one manage
message and read the response:

```jsonc
// send
{"seq":1000,"d":{
  "_t":"investHubs",
  "subscribe":[{"hub":"ff","area":"ff",
                "args":{"_t":"fund","fid":11479,"secret":"<userdata.secret>"}}],
  "queries":[], "unsubscribe":["ff"]}}

// receive
{"seqres":1000,"d":{"subscribed":[{"result":{
  "_v":40241, "v":98366.81, "b":98784.76, "reweighed":true,
  "order":{"S4":11,"S2":8}, "next_opt":{...}, "sellList":{},
  "sState":{ "S4":[11,-0.00137] }, "aState":{ "sellRatio":1.0, "holds":{...} },
  "ticks":[[epoch,rel],...], "history":[], "pcts":{...}, "pos":[[rank,of]] }}]}}
```

`order` = current picks, `next_opt` = scheduled picks, `v` = value, `b` = base.

### Game rules (from the bundle)

`initialMoney 100000`, picks 5–20, each 5–25 %, invested 75–100 %.
Season: soft launch 2026-09-21, hard launch 2026-10-05, end 2026-11-27.

---

## Command coverage

### Implemented

| Command | GUI equivalent |
| --- | --- |
| `auth` / `login` / `logout` / `config` | session handling |
| `whoami` | account / profile |
| `portfolio` (`funds`) | Overview + My portfolio (live) |
| `reweight` / `save` | My portfolio → Save |
| `cancel-reweight` | cancel scheduled reweight |
| `leagues`, `league <lid>` | Leagues, league page |
| `create-league`, `delete-league` | create / delete league |
| `fund-join` / `fund-request` / `fund-leave` / `fund-reject` / `fund-cancel` | join / request / leave / invite responses |
| `league-invite` / `league-join` / `league-reject` / `league-reset` | owner fund management |
| `negotiate` | fund-side negotiation decision |
| `player <pid>`, `activity` | player page, activity feed |
| `follow` / `unfollow` | follow buttons |
| `stocks` | tradable instrument universe |
| `serve` | run the HTTP + MCP server |
| `raw <path>` | any endpoint (escape hatch) |

Everything above is also available over MCP (`tools/call`), and MCP additionally
exposes `search_players`, which has no CLI command yet.

### Not wired to a CLI command (endpoint exists in `src/api.ts`)

- `PlayerBadges` — badges (available as nothing yet; use `raw`)
- `official-leagues`
- `historical-fund-performance` — historical chart
- `GetFundNegotiations` — fund-side negotiation list
- `league-search-to-invite` — owner invite search
- `LeagueNegotiateDecision` — league-side decision (only fund side exposed)
- `CreateFund` — creating a second fund
- `DeleteSelf` — delete the player
- `RegisterPlayerWithFund` — sign-up flow
- `searchplayerfund` — **available as the MCP tool `search_players`**, no CLI command

All of these can still be called today via `raw` (CLI) or `raw_request` (MCP).

### Not supported (separate systems, not in this API)

- Static content pages: Prize, How to play, Terms (CMS blocks)
- FT editorial / news feed
- Market movers & AI stock suggestions (separate `beakon` service)
- Full live market stream for every instrument
- Client-only state: theme (light/dark), cookie-consent banners

---

## Agent skill

`skills/ft-stockgame-cli/SKILL.md` is an installable skill (skills.sh format) that
teaches an agent when and how to use the CLI. Install from a published repo with:

```bash
npx skills add <owner>/ft-stockgame-cli
```

## License

MIT — see [LICENSE](./LICENSE). The disclaimer above always applies.
