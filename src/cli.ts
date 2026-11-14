#!/usr/bin/env node
import './boot.js';
import { loadConfig } from './config.js';
import { Core } from './core.js';
import { acquireLock, releaseLock } from './lock.js';
import { createLogger } from './logger.js';
import { normalizePhone } from './wa/jid.js';
import { errMsg } from './util.js';

const HELP = `whatsapp-mcp CLI

  node dist/cli.js pair --phone <digits> [--session default] [--wait 120]
      Link a WhatsApp number with a PAIRING CODE (no QR) straight from the terminal.
      Stop the MCP server first (only one process may own the connection), or use the session_pair tool instead.

  node dist/cli.js status      list sessions stored in the database
  node dist/cli.js logout --session <name>
`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (f: string, d?: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

async function main() {
  if (!cmd || cmd === '--help' || cmd === 'help') { console.error(HELP); return; }
  const cfg = loadConfig();
  const lock = acquireLock(cfg.dataDir);
  if (!lock.acquired && cmd !== 'status') {
    console.error(`Another whatsapp-mcp process (pid ${lock.info.pid}) owns the WhatsApp connection. Use the session_pair tool through your MCP client instead, or stop it first.`);
    process.exitCode = 2;
    return;
  }
  const core = new Core(cfg, createLogger(cfg), lock.acquired ? null : { pid: lock.info.pid });
  await core.start();
  try {
    if (cmd === 'status') {
      for (const s of core.sessions.values()) console.error(JSON.stringify(s.info()));
      if (!core.sessions.size) console.error('(no sessions)');
    } else if (cmd === 'pair') {
      const phone = normalizePhone(arg('--phone') ?? '');
      const name = Core.validName(arg('--session', 'default')!);
      const waitS = Number(arg('--wait', '120'));
      const s = core.createSession(name);
      const r = await s.pair(phone, { force: argv.includes('--force') });
      console.error(`\n  Pairing code for +${phone}:   ${r.code}\n`);
      console.error('  On the phone: WhatsApp > Settings > Linked devices > Link a device >');
      console.error('  "Link with phone number instead" > type the code above.\n');
      console.error(`  Waiting up to ${waitS}s for the link to complete...`);
      await s.waitOpen(waitS * 1000);
      console.error(`\n  Linked! session "${name}" is open as ${s.info().jid}. Giving WhatsApp a few seconds to sync history...`);
      await new Promise((r2) => setTimeout(r2, 20_000));
    } else if (cmd === 'logout') {
      const s = core.resolve(arg('--session'));
      await s.connect().catch(() => undefined);
      await s.waitOpen(30_000).catch(() => undefined);
      await s.logout();
      console.error(`session "${s.name}" logged out`);
    } else {
      console.error(HELP);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('error:', errMsg(e));
    process.exitCode = 1;
  } finally {
    await core.shutdown();
    if (lock.acquired) releaseLock(cfg.dataDir);
    process.exit();
  }
}

void main();
