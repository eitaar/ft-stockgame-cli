---
name: ft-stockgame-cli
description: >-
  Drive the FT Stock Picking Game (stockpickinggame.ft.com) from the command line
  instead of the browser. Use this whenever the user mentions the FT stock picking
  game, their fantasy portfolio or fund picks, "reweight", leagues, leaderboards,
  following players, or asks to check/save their stock game positions, automate
  picks, or script the game — even if they only say "my FT game" or "my portfolio".
  Also use when a task needs the game's REST/websocket API rather than clicking the UI.
metadata:
  author: eitaar
  version: "1.0.0"
  argument-hint: "[command or task, e.g. 'show my portfolio' or 'reweight to 60% tech']"
---

# FT Stock Picking Game CLI

`ft-stockgame-cli` performs the web GUI's operations against the game backend.
It reuses the session of the browser the user is **already logged into**, so there
is no login step and no password handling.

Repo/package: `ft-stockgame-cli` (TypeScript; builds to `dist/`). Entry points:
`node dist/node/cli.js <command>` for the CLI, `node dist/node/serve.js` for the
HTTP + MCP server, `src/worker.ts` for the Cloudflare Workers deployment.

> Unofficial and reverse-engineered: not affiliated with the FT or Norkon. Endpoints
> can change without notice. Writes change the user's **real** game state.

## Prerequisites — check these first

1. **Node.js >= 22** (Bun/Deno also work; Node is what's verified).
2. **A logged-in browser with remote debugging on.** The CLI reads the FT session
   cookie over the DevTools protocol (default port `9222`).
   - Verify: `curl http://127.0.0.1:9222/json/version` returns JSON.
   - If it does not, the browser is not started with debugging. Ask the user to
     fully close and relaunch it with the flag (their login persists), e.g.:
     ```powershell
     & "C:\Program Files\imput\Helium\Application\chrome.exe" --remote-debugging-port=9222
     ```
   - Alternatively, a user can bootstrap once with `--cookie "FTSession_s=..."` and
     never touch a browser again.
3. **Install + build once** (from the repo):
   ```bash
   npm install       # installs hono + the TS toolchain and builds dist/
   ```

## Authenticate / sanity check

Always start here. This proves the session works and prints the account context
(player id, fund id, secret):

```bash
node dist/node/cli.js whoami
```

- It tries, in order: `--token`, a cached JWT, a cached FT cookie, the browser on
  `:9222`, then a local browser profile. If it fails with "no DevTools endpoint" and
  no cached cookie exists, go back to prerequisite 2.
- The per-account `secret` printed here is required for the realtime feed.
- Flags for any command: `--json`, `--token <jwt>`, `--cookie <c>`, `--no-browser`,
  `--port <n>`.
- `node dist/node/cli.js auth --refresh` forces a fresh token. Refreshing is self-contained:
  once one FT cookie is cached, the CLI renews the JWT with no browser involved.
  Use `--no-browser` (or `STOCKGAME_NO_BROWSER=1`) to guarantee it never touches a
  browser — handy for headless / CI use.

## Core reads

```bash
node dist/node/cli.js portfolio                 # fund value, picks w/ names, day change,
                                          # scheduled (next-open) trades, exposure
node dist/node/cli.js leagues                   # leagues you are in
node dist/node/cli.js leagues --all             # every league
node dist/node/cli.js league <lid>              # league page, member funds, returns, history
node dist/node/cli.js player <pid>              # profile, followers/following, activity
node dist/node/cli.js activity                  # private activity feed
node dist/node/cli.js stocks --search <text>    # tradable instruments (eid/ticker/name)
node dist/node/cli.js invites                   # pending negotiations
node dist/node/cli.js requests <lid>            # negotiations for a league you own
```

`portfolio` shows both `order` (current) and `next_opt` (scheduled) so you can see
pending trades before touching anything.

## Writes (confirm with the user first)

Saving picks is the important one. `order` is a map of instrument key → percent,
e.g. `{"S4":11,"S2":8}`; keys come from `stocks`/`portfolio`.

```bash
# validate without sending (ALWAYS dry-run first)
node dist/node/cli.js reweight --fund <fid> --set "S4=11,S2=8,S40=6,S108=8,S5=11" --dry-run

# then save
node dist/node/cli.js reweight --fund <fid> --set "S4=11,S2=8,S40=6,S108=8,S5=11"
node dist/node/cli.js reweight --fund <fid> --file picks.json     # {eid:pct,...}
node dist/node/cli.js reweight --fund <fid> --current              # re-save current picks
node dist/node/cli.js cancel-reweight --fund <fid>
```

The tool enforces the game rules (picks 5–20, each 5–25 %, invested 75–100 %) and
refuses invalid orders unless `--allow-invalid` is passed. Reweights execute at the
next market open, not immediately.

Other writes: `follow`/`unfollow <pid>`, `create-league <name>`,
`delete-league <lid> --yes`, `fund-join`/`fund-request`/`fund-leave`/`fund-reject`/
`fund-cancel <lid> --fund <fid>`, `league-invite`/`league-join`/`league-reject`/
`league-reset <lid> <fid>`, `negotiate <lid> <fid> --accept|--reject`.

## Escape hatch

Any endpoint not surfaced as a command can be called directly. Run
`node dist/node/cli.js raw <path> [--method POST] [--data '<json>']`, e.g.
`raw "FantasyFunds/searchplayerfund?term=<name>"`. See the repo README for the full
endpoint list and payloads.

## MCP server mode (preferred for agents)

Instead of shelling out to the CLI, prefer the built-in **MCP server** when the
client can speak MCP. It exposes the same operations as tools.

```bash
node dist/node/cli.js serve --host 127.0.0.1 --port 8787
# Streamable HTTP MCP endpoint: http://127.0.0.1:8787/mcp
```

- Register it with a Streamable-HTTP MCP client, e.g.
  `claude mcp add --transport http stockgame http://127.0.0.1:8787/mcp`.
- Tools: `whoami`, `portfolio`, `list_leagues`, `league_details`, `player_profile`,
  `search_players`, `activity_feed`, `stock_universe`, `list_negotiations`,
  `save_picks`, `cancel_reweight`, `follow`, `unfollow`, `create_league`,
  `delete_league`, `join_league`, `leave_league`, `request_join`, `reject_invite`,
  `cancel_request`, `league_invite`, `league_join`, `league_reject`, `league_reset`,
  `negotiate`, `raw_request`.
- `save_picks` takes `{ fund?, order, dryRun?, allowInvalid? }` and enforces the
  picker rules; `delete_league` requires `confirm: true`.
- It authenticates lazily on the first tool call and honours `--no-browser`.
- **Cloudflare Workers**: the same app is deployed from `src/worker.ts` +
  `wrangler.toml`. Set the `STOCKGAME_COOKIE` secret (the `FTSession_s` value) and
  optionally `STOCKGAME_MCP_TOKEN`; `npx wrangler deploy`. No KV needed — the JWT is
  memoised in isolate memory and the feed uses the HTTP Pulse endpoint.

## Safety rules

- **Dry-run first** for any `reweight` / `save_picks`; show the user the resulting
  picks before saving.
- **Never** run destructive tools (`delete_league`, `--allow-invalid` writes, or
  anything that deletes a player) without explicit confirmation.
- Do not print or commit the session cookie / JWT. The session file lives at
  `~/.config/stockgame/session.json` and must stay out of version control.
- If a call returns "not logged in", ask the user to confirm they are logged into
  `ft.com` in the debug-enabled browser; do not attempt to collect credentials.

## Reference

`node dist/node/cli.js --help` lists every command. The repo README documents the REST
API, the MCP tools, and the `Pulse` websocket protocol this project relies on.
