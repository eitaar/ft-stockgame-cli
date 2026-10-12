import type { SessionData } from './types.js';

/**
 * Where the session (FT cookie + JWT) lives. Injected so the same core runs with a
 * file store on Node and in isolate memory on Cloudflare Workers.
 */
export interface SessionStore {
  read(): SessionData | null;
  write(session: SessionData): void;
  clear(): void;
}

/** Process/isolate-local store. Used on Workers, and as the default elsewhere. */
export class MemorySessionStore implements SessionStore {
  #session: SessionData | null = null;

  read(): SessionData | null {
    return this.#session;
  }

  write(session: SessionData): void {
    this.#session = session;
  }

  clear(): void {
    this.#session = null;
  }
}
