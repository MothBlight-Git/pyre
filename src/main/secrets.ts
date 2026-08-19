/**
 * API key storage — one encrypted blob holding a key per provider.
 *
 * Encrypted with Electron's safeStorage, which wraps DPAPI on Windows: the
 * ciphertext is bound to the current user account, so copying credentials.bin
 * to another machine or another user yields nothing. Deliberately NOT in
 * settings.json — that file travels with a portable install and is the one
 * people paste into issues.
 *
 * The plaintext never leaves the main process. The renderer can set, clear and
 * ask whether a key exists; it can never read one back.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';

const FILE = 'credentials.bin';

/** Env fallbacks, checked per provider. Never written to disk. */
const ENV_VARS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  ollama: [],
  custom: ['PYRE_API_KEY'],
};

export interface KeyStatus {
  configured: boolean;
  source: 'stored' | 'env' | 'none';
  encryptionAvailable: boolean;
  /** Last 4 characters only, so you can tell which key it is. Never the whole key. */
  hint: string | null;
}

const file = (dir: string) => path.join(dir, FILE);

function fromEnv(provider: string): string | null {
  for (const name of ENV_VARS[provider] ?? []) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function readAll(dir: string, log: (m: string) => void): Record<string, string> {
  const f = file(dir);
  if (!fs.existsSync(f)) return {};
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      log('secrets: OS encryption unavailable, cannot read stored keys');
      return {};
    }
    const raw = safeStorage.decryptString(fs.readFileSync(f)).trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // v0.3 stored a bare key string for Anthropic; keep those working.
    if (typeof parsed === 'string') return { anthropic: parsed };
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    // Wrong user account, corrupted file, or a pre-JSON single key.
    try {
      const legacy = safeStorage.decryptString(fs.readFileSync(f)).trim();
      if (legacy && !legacy.startsWith('{')) return { anthropic: legacy };
    } catch { /* fall through */ }
    log(`secrets: could not read stored keys (${(e as Error).message})`);
    return {};
  }
}

function writeAll(dir: string, map: Record<string, string>, log: (m: string) => void): boolean {
  if (!safeStorage.isEncryptionAvailable()) {
    log('secrets: refusing to store — OS encryption unavailable');
    return false;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const enc = safeStorage.encryptString(JSON.stringify(map));
    const tmp = file(dir) + '.tmp';
    fs.writeFileSync(tmp, enc, { mode: 0o600 });
    fs.renameSync(tmp, file(dir));
    try { fs.chmodSync(file(dir), 0o600); } catch { /* best effort on Windows */ }
    return true;
  } catch (e) {
    log(`secrets: write failed (${(e as Error).message})`);
    return false;
  }
}

export function getKey(dir: string, provider: string, log: (m: string) => void = () => {}): string | null {
  const env = fromEnv(provider);
  if (env) return env;
  const k = readAll(dir, log)[provider];
  return k && k.trim() ? k.trim() : null;
}

export function setKey(dir: string, provider: string, key: string, log: (m: string) => void = () => {}): KeyStatus {
  const trimmed = key.trim();
  const map = readAll(dir, log);
  if (trimmed) map[provider] = trimmed; else delete map[provider];
  writeAll(dir, map, log);
  return status(dir, provider, log);
}

export function clearKey(dir: string, provider: string, log: (m: string) => void = () => {}): KeyStatus {
  return setKey(dir, provider, '', log);
}

export function status(dir: string, provider: string, log: (m: string) => void = () => {}): KeyStatus {
  const encryptionAvailable = (() => {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  })();
  const env = fromEnv(provider);
  if (env) return { configured: true, source: 'env', encryptionAvailable, hint: tail(env) };
  const k = readAll(dir, log)[provider];
  return {
    configured: !!(k && k.trim()),
    source: k && k.trim() ? 'stored' : 'none',
    encryptionAvailable,
    hint: k && k.trim() ? tail(k) : null,
  };
}

function tail(key: string): string {
  return key.length <= 4 ? '••••' : '••••' + key.slice(-4);
}
