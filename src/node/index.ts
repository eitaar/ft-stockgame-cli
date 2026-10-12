/** Node/Bun/Deno-only adapters (filesystem, DevTools, server entry, CLI). */
export { FileSessionStore, CONFIG_DIR, SESSION_FILE } from './store-file.js';
export { browserCookies, ftsessionCookie } from './cdp.js';
export { startServer } from './serve.js';
export type { ServeOptions, RunningServer } from './serve.js';
