/**
 * PYRE stdio MCP server entry. Runs as plain Node inside the Pyre binary
 * (`Pyre.exe --mcp` re-spawns this file with ELECTRON_RUN_AS_NODE=1).
 *
 * stdout is reserved for JSON-RPC. Log to stderr only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolvePaths } from '../main/paths';
import { Store } from '../main/store';
import { registerPyreTools, PYRE_MCP_VERSION } from './tools';

const log = (m: string) => process.stderr.write(`[pyre-mcp] ${m}\n`);

const paths = resolvePaths();
const store = new Store(paths, log);
store.load();

const server = new McpServer({ name: 'pyre', version: PYRE_MCP_VERSION });
// No fs.watch here: every tool call re-reads the file if it changed on disk, so
// the app and any number of MCP clients stay consistent without a long-lived watcher.
registerPyreTools(server, store, () => store.reload());

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready · ${paths.notesFile}`);
}

main().catch((e) => { log(String(e?.stack ?? e)); process.exit(1); });
