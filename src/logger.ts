import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import type { Config } from './config.js';

/**
 * stdout belongs to the MCP protocol (stdio transport). Everything human-readable
 * goes to stderr and to a rotating-by-day file under <data>/logs.
 */
export function createLogger(cfg: Config): Logger {
  fs.mkdirSync(cfg.logDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = pino.destination({ dest: path.join(cfg.logDir, `whatsapp-mcp-${day}.log`), sync: true, mkdir: true });
  const stderr = pino.destination({ dest: 2, sync: true });
  return pino(
    { level: cfg.logLevel, base: undefined, redact: ['*.authKey', '*.creds', 'creds', 'token'] },
    pino.multistream([
      { stream: file, level: cfg.logLevel as pino.Level },
      { stream: stderr, level: 'warn' },
    ]),
  );
}

/** Baileys is chatty: give it a child logger pinned to a quieter level. */
export function baileysLogger(root: Logger, session: string): Logger {
  const level = ['trace', 'debug'].includes(root.level) ? root.level : 'warn';
  return root.child({ module: 'baileys', session }, { level });
}
