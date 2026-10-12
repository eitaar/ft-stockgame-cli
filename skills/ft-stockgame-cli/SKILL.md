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

Repo/package: `ft-stockgame-cli`. The CLI entry point is `src/cli.js`
(`node src/cli.js <command>` once installed, or `node /path/to/repo/src/cli.js`).

> Unofficial and reverse-engineered: not affiliated with the FT or Norkon. Endpoints
> can change without notice. Writes change the user's **real** game state.

## Prerequisites — check these first

1. **Node.js >= 22.**
2. **A logged-in browser with remote debugging on.** The CLI reads the FT session
   cookie over the DevTools protocol (default port `9222`).
   - Verify: `curl http://127.0.0.1:9222/json/version` returns JSON.
   - If it does not, the browser is not started with debugging. Ask the user to
     fully close and relaunch it with the flag (their login persists), e.g.:
     ```powershell
     & "C:\Program Files\imput\Helium\Application\chrome.exe" --remote-debugging-port=9222
     ```
3. **Install the CLI once** (from the repo):
   ```bash
   npm install       # pulls the single dependency, `ws`
   ```

## Authenticate / sanity check

Always start here. This proves the session works and prints the account context
(player id, fund id, secret):

```bash
node src/cli.js whoami
```

- It tries, in order: `--token`, a cached JWT, an `--cookie`, then the browser on
  `:9222`. If it fails with "no DevTools endpoint", go back to prerequisite 2.
- The per-account `secret` printed here is required for the realtime feed.
- Flags for any command: `--json`, `--token <jwt>`, `--cookie <c>`, `--port <n>`.
- `node src/cli.js auth --refresh` forces a fresh token.

## Core reads

```bash
node src/cli.js portfolio                 # fund value, picks w/ names, day change,
                                          # scheduled (next-open) trades, exposure
node src/cli.js leagues                   # leagues you are in
node src/cli.js leagues --all             # every league
node src/cli.js league <lid>              # league page, member funds, returns, history
node src/cli.js player <pid>              # profile, followers/following, activity
node src/cli.js activity                  # private activity feed
node src/cli.js stocks --search <text>    # tradable instruments (eid/ticker/name)
node src/cli.js invites                   # pending negotiations
node src/cli.js requests <lid>            # negotiations for a league you own
```

`portfolio` shows both `order` (current) and `next_opt` (scheduled) so you can see
pending trades before touching anything.

## Writes (confirm with the user first)

Saving picks is the important one. `order` is a map of instrument key → percent,
e.g. `{"S4":11,"S2":8}`; keys come from `stocks`/`portfolio`.

```bash
# validate without sending (ALWAYS dry-run first)
node src/cli.js reweight --fund <fid> --set "S4=11,S2=8,S40=6,S108=8,S5=11" --dry-run

# then save
node src/cli.js reweight --fund <fid> --set "S4=11,S2=8,S40=6,S108=8,S5=11"
node src/cli.js reweight --fund <fid> --file picks.json     # {eid:pct,...}
node src/cli.js reweight --fund <fid> --current              # re-save current picks
node src/cli.js cancel-reweight --fund <fid>
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
`node src/cli.js raw <path> [--method POST] [--data '<json>']`, e.g.
`raw "FantasyFunds/searchplayerfund?term=<name>"`. See the repo README for the full
endpoint list and payloads.

## Safety rules

- **Dry-run first** for any `reweight`; show the user the resulting picks before saving.
- **Never** run destructive commands (`delete-league`, `--allow-invalid` writes, or
  anything that deletes a player) without explicit confirmation.
- Do not print or commit the session cookie / JWT. The session file lives at
  `~/.config/stockgame/session.json` and must stay out of version control.
- If a call returns "not logged in", ask the user to confirm they are logged into
  `ft.com` in the debug-enabled browser; do not attempt to collect credentials.

## Reference

`node src/cli.js --help` lists every command. The repo README documents the REST
API and the `Pulse` websocket protocol the CLI relies on.
