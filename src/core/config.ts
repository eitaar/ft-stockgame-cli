/**
 * Runtime-agnostic constants. No `node:` imports and no `process` here, so this
 * module can be bundled for Cloudflare Workers.
 */

export const HTTP_BASE = 'https://api.ft-s02-prod.fantasy.norkon.net/api/';

/** The realtime feed's plain-HTTP endpoint (no websocket required). */
export const PULSE_HTTP_URL = 'https://api.ft-s02-prod.fantasy.norkon.net/Pulse/Request/';

/** The realtime feed's websocket endpoint. */
export const PULSE_WS_URL = 'wss://api.ft-s02-prod.fantasy.norkon.net/Pulse/';

export const ORIGIN = 'https://stockpickinggame.ft.com';
export const GAME_URL = 'https://stockpickinggame.ft.com/';

/** Rules the web picker enforces (from the Nuxt config in the game bundle). */
export const RULES = {
  initialMoney: 100000,
  minPicks: 5,
  maxPicks: 20,
  minPickPct: 5,
  maxPickPct: 25,
  minInvestedPct: 75,
  maxInvestedPct: 100,
} as const;

/** 2-digit GICS sector code -> label (as shown in the picker). */
export const GICS: Record<number, string> = {
  10: 'Energy',
  15: 'Materials',
  20: 'Industrials',
  25: 'Consumer Discretionary',
  30: 'Consumer Staples',
  35: 'Health Care',
  40: 'Financials',
  45: 'Information Technology',
  50: 'Communication Services',
  55: 'Utilities',
  60: 'Real Estate',
};
