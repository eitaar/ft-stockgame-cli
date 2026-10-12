import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HTTP_BASE = 'https://api.ft-s02-prod.fantasy.norkon.net/api/';
export const ORIGIN = 'https://stockpickinggame.ft.com';
export const GAME_URL = 'https://stockpickinggame.ft.com/';

export const CONFIG_DIR = process.env.STOCKGAME_CONFIG_DIR || path.join(os.homedir(), '.config', 'stockgame');
export const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

/** Rules the web picker enforces (from the Nuxt config in the game bundle). */
export const RULES = {
  initialMoney: 100000,
  minPicks: 5,
  maxPicks: 20,
  minPickPct: 5,
  maxPickPct: 25,
  minInvestedPct: 75,
  maxInvestedPct: 100,
};

/** 2-digit GICS sector code -> label (as shown in the picker). */
export const GICS = {
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

export function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(session) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  try {
    fs.chmodSync(SESSION_FILE, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

export function clearSession() {
  try {
    fs.rmSync(SESSION_FILE);
  } catch {
    /* ignore */
  }
}
