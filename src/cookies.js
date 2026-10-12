import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * Read the FT session cookie straight out of a Chromium-family profile's cookie
 * store, decrypting it locally. This lets the CLI refresh its session without a
 * DevTools endpoint — as long as the browser is closed (the store is exclusively
 * locked while it runs).
 *
 * Windows only: cookie values are protected with DPAPI + AES-256-GCM, and DPAPI
 * is invoked through PowerShell (no native module needed).
 */

// node:sqlite emits an ExperimentalWarning on first use; keep the CLI output clean.
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/SQLite is an experimental feature/.test(message)) return;
  return originalEmitWarning.call(process, warning, ...rest);
};

function candidateUserDataDirs() {
  const local = process.env.LOCALAPPDATA;
  const home = os.homedir();
  const list = [];
  if (process.env.STOCKGAME_USER_DATA) list.push(process.env.STOCKGAME_USER_DATA);
  if (process.platform === 'win32' && local) {
    list.push(
      path.join(local, 'imput', 'Helium', 'User Data'),
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Microsoft', 'Edge', 'User Data'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      path.join(local, 'Chromium', 'User Data'),
    );
  } else if (process.platform === 'darwin') {
    list.push(
      path.join(home, 'Library', 'Application Support', 'Helium'),
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      path.join(home, 'Library', 'Application Support', 'Chromium'),
    );
  } else {
    list.push(
      path.join(home, '.config', 'helium'),
      path.join(home, '.config', 'google-chrome'),
      path.join(home, '.config', 'chromium'),
    );
  }
  return list;
}

function dpapiUnprotect(b64) {
  if (process.platform !== 'win32') return null;
  // The ProtectedData type is not loaded by default in every PowerShell edition,
  // so try both assembly names (PowerShell 7 vs 5.1).
  const script =
    "$ErrorActionPreference='Stop';" +
    "try{Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop}" +
    "catch{Add-Type -AssemblyName System.Security -ErrorAction Stop};" +
    `$b=[Convert]::FromBase64String('${b64}');` +
    `$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `[BitConverter]::ToString($u).Replace('-','')`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const hex = out.trim();
    return hex ? Buffer.from(hex, 'hex') : null;
  } catch {
    return null;
  }
}

function aesKeyFor(userDataDir) {
  const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
  const enc = localState?.os_crypt?.encrypted_key;
  if (!enc) return null;
  const raw = Buffer.from(enc, 'base64');
  // strip the "DPAPI" prefix
  return dpapiUnprotect(raw.subarray(5).toString('base64'));
}

function decryptValue(encBuf, key) {
  const enc = Buffer.from(encBuf);
  const v = enc.subarray(0, 3).toString('latin1');
  if (v !== 'v10' && v !== 'v11') return null; // v20 = app-bound encryption, unsupported
  const d = crypto.createDecipheriv('aes-256-gcm', key, enc.subarray(3, 15));
  d.setAuthTag(enc.subarray(enc.length - 16));
  const plain = Buffer.concat([d.update(enc.subarray(15, enc.length - 16)), d.final()]);
  // Chromium prefixes the plaintext with a SHA-256 of the domain (32 bytes)
  return plain.subarray(32).toString('utf8');
}

/** Return FTSession_s from a local Chromium profile, or null. */
export async function cookieFromProfile() {
  if (process.platform !== 'win32') return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null;
  }

  for (const dir of candidateUserDataDirs()) {
    if (!fs.existsSync(path.join(dir, 'Local State'))) continue;
    let key;
    try {
      key = aesKeyFor(dir);
    } catch {
      continue;
    }
    if (!key) continue;

    const profiles = fs
      .readdirSync(dir)
      .filter((n) => n === 'Default' || /^Profile \d+$/.test(n));
    for (const profile of profiles) {
      const cookiePath = path.join(dir, profile, 'Network', 'Cookies');
      if (!fs.existsSync(cookiePath)) continue;
      let db;
      try {
        db = new DatabaseSync(cookiePath, { readOnly: true });
      } catch {
        continue; // locked because the browser is running
      }
      try {
        const rows = db
          .prepare(`SELECT name, encrypted_value FROM cookies WHERE name = 'FTSession_s' AND host_key LIKE '%.ft.com'`)
          .all();
        for (const row of rows) {
          try {
            const value = decryptValue(row.encrypted_value, key);
            if (value) return `FTSession_s=${value}`;
          } catch {
            /* keep looking */
          }
        }
      } finally {
        db.close();
      }
    }
  }
  return null;
}
