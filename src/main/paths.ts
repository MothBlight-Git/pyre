/**
 * Data directory resolution (CLAUDE.md §6.2). First hit wins:
 *   1. PYRE_DATA env var
 *   2. `pyre.portable` marker beside the executable → ./pyre-data/
 *   3. ./pyre-data/ beside the executable exists AND is writable → portable
 *   4. ~/.stickyburn/ → installed
 *
 * Writability is probed with a real temp-file write — USB sticks and locked
 * corporate directories lie to permission checks.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type DataMode = 'env' | 'portable' | 'installed';

export interface ResolvedPaths {
  mode: DataMode;
  dir: string;
  notesFile: string;
  settingsFile: string;
  /** Set when a portable location was wanted but unwritable and we fell back. */
  fellBackFrom: string | null;
}

export function probeWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.pyre-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'probe');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Directory the executable lives in. In dev (electron .) this is the project root. */
export function exeDir(): string {
  // When packaged, process.execPath is Pyre.exe (portable stub extracts to temp,
  // but electron-builder exposes the original location via PORTABLE_EXECUTABLE_DIR).
  // The --mcp child (plain Node) is told explicitly via PYRE_EXE_DIR.
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || process.env.PYRE_EXE_DIR;
  if (portableDir) return portableDir;
  if (process.defaultApp || /[\\/]electron(\.exe)?$/i.test(process.execPath)) {
    return process.cwd();
  }
  return path.dirname(process.execPath);
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): ResolvedPaths {
  const finish = (mode: DataMode, dir: string, fellBackFrom: string | null): ResolvedPaths => ({
    mode,
    dir,
    notesFile: path.join(dir, 'notes.json'),
    settingsFile: path.join(dir, 'settings.json'),
    fellBackFrom,
  });

  const installed = path.join(os.homedir(), '.stickyburn');

  // 1. env var
  if (env.PYRE_DATA) {
    const dir = path.resolve(env.PYRE_DATA);
    if (probeWritable(dir)) return finish('env', dir, null);
    if (probeWritable(installed)) return finish('installed', installed, dir);
  }

  const beside = exeDir();
  const marker = path.join(beside, 'pyre.portable');
  const portableDir = path.join(beside, 'pyre-data');

  // 2. marker file
  if (fs.existsSync(marker)) {
    if (probeWritable(portableDir)) return finish('portable', portableDir, null);
    probeWritable(installed);
    return finish('installed', installed, portableDir);
  }

  // 3. pyre-data already exists and is writable
  if (fs.existsSync(portableDir)) {
    if (probeWritable(portableDir)) return finish('portable', portableDir, null);
    probeWritable(installed);
    return finish('installed', installed, portableDir);
  }

  // 4. installed
  probeWritable(installed);
  return finish('installed', installed, null);
}
