/**
 * Ready-to-paste MCP client config. Claude Desktop, Cursor and Claude Code all
 * read the same `mcpServers` shape:
 *   - stdio:  { command, args }         → `Pyre.exe --mcp`
 *   - http:   { url }                    → the running app's local endpoint
 * Cursor reads it from `.cursor/mcp.json` (project) or `~/.cursor/mcp.json`.
 * Claude Desktop reads `claude_desktop_config.json` (stdio only).
 *
 * In dev (not packaged) the stdio "command" is the electron binary with the
 * project dir + --mcp, because there is no Pyre.exe yet.
 */
export type Launcher = 'dev' | 'exe' | 'portable-stub';

export function detectLauncher(packaged: boolean): Launcher {
  if (!packaged) return 'dev';
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable-stub';
  return 'exe';
}

export function mcpConfigSnippets(
  exePath: string,
  launcher: Launcher,
  httpUrl: string | null,
): { stdio: string | null; http: string | null } {
  let stdio: string | null;
  if (launcher === 'portable-stub') {
    // The NSIS launcher ExecWait()s the real app without inheriting stdio, so
    // `Pyre.exe --mcp` through the stub can never answer on stdout.
    stdio = null;
  } else {
    const server = launcher === 'dev'
      ? { command: exePath, args: [process.cwd(), '--mcp'] }
      : { command: exePath, args: ['--mcp'] };
    stdio = JSON.stringify({ mcpServers: { pyre: server } }, null, 2);
  }
  const http = httpUrl ? JSON.stringify({ mcpServers: { pyre: { url: httpUrl } } }, null, 2) : null;
  return { stdio, http };
}
