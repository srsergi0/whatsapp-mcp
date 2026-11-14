import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { iso } from '../../util.js';
import { hasFfmpeg, safeName } from '../../wa/media.js';
import { defineTool, limitField, sessionField, type Env } from '../helpers.js';
import { parseTime } from './read.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerAdminTools(env: Env) {
  const { core } = env;

  defineTool(env, 'server_info', {
    title: 'Server info and health',
    description: 'Version, uptime, configuration (toolsets, read-only, throttles), database size, ffmpeg availability, timezone and per-session state. Call this first when something misbehaves.',
    toolset: 'admin',
    network: false,
    input: {},
  }, async () => {
    const dbSize = (() => { try { return fs.statSync(core.cfg.dbPath).size; } catch { return 0; } })();
    return {
      name: 'whatsapp-mcp', version: core.cfg.version, node: process.version, pid: process.pid, uptime_s: Math.round((Date.now() - core.startedAt) / 1000),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: new Date().toISOString(),
      data_dir: core.cfg.dataDir, db: { path: core.cfg.dbPath, bytes: dbSize, schema_version: core.db.schemaVersion },
      mode: core.passive ? `passive (pid ${core.passive.pid} owns connections)` : core.cfg.readOnly ? 'read-only' : 'read-write',
      toolsets: [...core.cfg.toolsets], throttle: { send_delay_ms: core.cfg.sendDelayMs, max_msgs_per_min: core.cfg.maxMsgsPerMin },
      auto_download_media: core.cfg.autoDownload, ffmpeg: await hasFfmpeg(),
      sessions: [...core.sessions.values()].map((s) => ({ name: s.name, state: s.state, phone: s.info().phone })),
      totals: core.repo.stats(),
    };
  });

  defineTool(env, 'audit_log', {
    title: 'Audit log of actions',
    description: 'Recent state-changing tool calls (sends, deletes, settings) made through this server, with success flag. Useful to review what an agent did.',
    toolset: 'admin',
    network: false,
    input: { session: sessionField.optional(), limit: limitField(50, 500) },
  }, async (a) => {
    const rows = core.repo.listAudit(a.limit, a.session) as any[];
    return { entries: rows.map((r) => ({ id: r.id, time: iso(r.ts), session: r.session ?? undefined, tool: r.tool, target: r.target ?? undefined, ok: !!r.ok, detail: r.detail ?? undefined })) };
  });

  defineTool(env, 'export_chat', {
    title: 'Export a chat to a file',
    description: 'Write the stored conversation to a file under <data>/exports (markdown, jsonl or json) and return its path. Does not put the content in the response.',
    toolset: 'admin',
    effect: 'local',
    network: false,
    input: {
      session: sessionField,
      chat: z.string(),
      format: z.enum(['markdown', 'jsonl', 'json']).default('markdown'),
      since: z.string().optional(),
      until: z.string().optional(),
      max_messages: z.number().int().min(1).max(100000).default(20000),
    },
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const jid = ctx.chat(s.name, a.chat);
    const p = ctx.presenter(s.name);
    const since = parseTime(a.since);
    const until = parseTime(a.until);
    const collected: any[] = [];
    let before: [number, number] | undefined;
    while (collected.length < a.max_messages) {
      const page = core.repo.listMessages(s.name, { chat: jid, limit: 500, since, until, before });
      if (!page.length) break;
      collected.push(...page);
      const last = page[page.length - 1]!;
      before = [last.ts, last._rid];
      if (page.length < 500) break;
    }
    collected.reverse();
    const dir = path.join(core.cfg.dataDir, 'exports');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${safeName(p.name(jid) ?? jid)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.${a.format === 'markdown' ? 'md' : a.format === 'jsonl' ? 'jsonl' : 'json'}`);
    const msgs = p.messages(collected);
    let body: string;
    if (a.format === 'jsonl') body = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
    else if (a.format === 'json') body = JSON.stringify({ chat: jid, name: p.name(jid), messages: msgs }, null, 2);
    else {
      body = `# ${p.name(jid) ?? jid}\n\n`;
      let day = '';
      for (const m of msgs as any[]) {
        const d = (m.time as string).slice(0, 10);
        if (d !== day) { day = d; body += `\n## ${d}\n\n`; }
        const who = m.from_me ? 'Me' : (m.sender_name ?? m.sender ?? '?');
        const media = m.media ? ` _[${m.type}${m.media.name ? ': ' + m.media.name : ''}]_` : '';
        const quote = m.quoted ? `> ${m.quoted.text ?? ''}\n` : '';
        body += `${quote}**${(m.time as string).slice(11, 16)} ${who}:** ${m.text ?? m.caption ?? ''}${media}${m.deleted ? ' _(deleted)_' : ''}\n\n`;
      }
    }
    await fsp.writeFile(file, body, 'utf8');
    return { file, messages: msgs.length, bytes: Buffer.byteLength(body) };
  });

  defineTool(env, 'db_maintenance', {
    title: 'Database maintenance',
    description:
      'backup: consistent copy of the database to <data>/backups (CONTAINS WhatsApp credentials - keep private). optimize: update planner stats. vacuum: reclaim space. ' +
      'prune_events: delete journal events older than N days. rebuild_search: rebuild the full-text index.',
    toolset: 'admin',
    effect: 'local',
    network: false,
    input: { action: z.enum(['backup', 'optimize', 'vacuum', 'prune_events', 'rebuild_search']), days: z.number().int().min(1).max(3650).default(30) },
  }, async (a) => {
    switch (a.action) {
      case 'backup': {
        const dir = path.join(core.cfg.dataDir, 'backups');
        await fsp.mkdir(dir, { recursive: true });
        const file = path.join(dir, `whatsapp-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
        core.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
        return { file, bytes: fs.statSync(file).size, warning: 'Contains credentials; do not share.' };
      }
      case 'optimize': core.db.exec('PRAGMA optimize; ANALYZE'); return { ok: true };
      case 'vacuum': core.db.exec('VACUUM'); return { ok: true };
      case 'prune_events': return { deleted: core.repo.pruneEvents(a.days) };
      case 'rebuild_search': core.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"); return { ok: true };
    }
  });
}
