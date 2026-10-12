import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { SessionStore } from '../core/session.js';
import type { SessionData } from '../core/types.js';

export const CONFIG_DIR =
  process.env.STOCKGAME_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'stockgame');
export const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

/** File-backed session store for Node/Bun/Deno (best-effort 0600). */
export class FileSessionStore implements SessionStore {
  #file: string;

  constructor(file: string = SESSION_FILE) {
    this.#file = file;
  }

  read(): SessionData | null {
    try {
      return JSON.parse(fs.readFileSync(this.#file, 'utf8')) as SessionData;
    } catch {
      return null;
    }
  }

  write(session: SessionData): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(this.#file, JSON.stringify(session, null, 2));
    try {
      fs.chmodSync(this.#file, 0o600);
    } catch {
      /* best effort on Windows */
    }
  }

  clear(): void {
    try {
      fs.rmSync(this.#file);
    } catch {
      /* ignore */
    }
  }
}
