/**
 * API key storage.
 *
 * The key is encrypted with Electron's safeStorage, which on Windows wraps
 * DPAPI — the ciphertext is bound to the current user account, so copying
 * `credentials.bin` to another machine or another user yields nothing. It is
 * deliberately NOT in settings.json: that file travels with a portable install
 * and is the file people paste into issues.
 *
 * The plaintext key never leaves the main process. The renderer can ask whether
 * one is configured and can set or clear it, but can never read it back.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';

const FILE = 'credentials.bin';

export interface KeyStatus {
  /** A key is available from either the encrypted file or the environment. */
  configured: boolean;
  /** Where it came from. `env` wins and is never written to disk. */
  source: 'stored' | 'env' | 'none';
  /** False when the OS refused to provide encryption (rare; Linux w/o keyring). */
  encryptionAvailable: boolean;
  /** Last 4 characters, for "is this the key I think it is?". Never the whole key. */
  hint: string | null;
}

function file(dir: string): string {
  return path.join(dir, FILE);
}

/** ANTHROPIC_API_KEY wins if set — the standard escape hatch, and never persisted. */
function fromEnv(): string | null {
  const v = process.env.ANTHROPIC_API_KEY;
  return v && v.trim() ? v.trim() : null;
}

export function getKey(dir: string, log: (m: string) => void = () => {}): string | null {
  const env = fromEnv();
  if (env) return env;
  const f = file(dir);
  if (!fs.existsSync(f)) return null;
  try {
    const buf = fs.readFileSync(f);
    if (!safeStorage.isEncryptionAvailable()) {
      log('secrets: OS encryption unavailable, cannot read stored key');
      return null;
    }
    const key = safeStorage.decryptString(buf).trim();
    return key || null;
  } catch (e) {
    // Wrong user account, corrupted file, or a different machine.
    log(`secrets: could not decrypt stored key (${(e as Error).message})`);
    return null;
  }
}

export function setKey(dir: string, key: string, log: (m: string) => void = () => {}): KeyStatus {
  const trimmed = key.trim();
  if (!trimmed) return clearKey(dir, log);
  if (!safeStorage.isEncryptionAvailable()) {
    // Refuse rather than silently writing plaintext.
    log('secrets: refusing to store key — OS encryption unavailable');
    return status(dir, log);
  }
  fs.mkdirSync(dir, { recursive: true });
  const enc = safeStorage.encryptString(trimmed);
  const tmp = file(dir) + '.tmp';
  fs.writeFileSync(tmp, enc, { mode: 0o600 });
  fs.renameSync(tmp, file(dir));
  try { fs.chmodSync(file(dir), 0o600); } catch { /* best effort on Windows */ }
  return status(dir, log);
}

export function clearKey(dir: string, log: (m: string) => void = () => {}): KeyStatus {
  try { if (fs.existsSync(file(dir))) fs.unlinkSync(file(dir)); }
  catch (e) { log(`secrets: could not remove key file (${(e as Error).message})`); }
  return status(dir, log);
}

export function status(dir: string, log: (m: string) => void = () => {}): KeyStatus {
  const encryptionAvailable = (() => {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  })();
  if (fromEnv()) {
    const k = fromEnv()!;
    return { configured: true, source: 'env', encryptionAvailable, hint: tail(k) };
  }
  const k = getKey(dir, log);
  return {
    configured: !!k,
    source: k ? 'stored' : 'none',
    encryptionAvailable,
    hint: k ? tail(k) : null,
  };
}

function tail(key: string): string {
  return key.length <= 4 ? '••••' : '••••' + key.slice(-4);
}
