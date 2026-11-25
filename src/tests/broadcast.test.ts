import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { Core } from '../core.js';
import { loadConfig } from '../config.js';
import { interpolateTemplate, formatDuration } from '../mcp/tools/messages.js';
import { createMcpServer } from '../mcp/server.js';

test('interpolateTemplate replaces standard and custom variables', () => {
  const template = 'Hola {{name}}, tu primer nombre es {{first_name}}, teléfono {{phone}}, código {{code}}, monto S/ {{amount}}. Extra: {{unreplaced}}';
  const vars = {
    name: 'Willi Alberto Mendoza',
    first_name: 'Willi',
    phone: '51917051504',
    code: 'PROMO-2026',
    amount: '150.00',
  };
  const result = interpolateTemplate(template, vars);
  assert.equal(
    result,
    'Hola Willi Alberto Mendoza, tu primer nombre es Willi, teléfono 51917051504, código PROMO-2026, monto S/ 150.00. Extra: {{unreplaced}}',
  );
});

test('formatDuration formats seconds accurately', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(3665), '1h 1m 5s');
});

test('broadcast_message dry_run and execution with anti-ban jitter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bcast-'));
  const cfg = { ...loadConfig(), dataDir: dir, dbPath: path.join(dir, 'test.db'), mediaDir: path.join(dir, 'media'), logDir: path.join(dir, 'logs') };
  const core = new Core(cfg, pino({ level: 'silent' }));

  try {
    core.createSession('test-session');
    // Seed contacts
    core.repo.upsertContact('test-session', '51917051504@s.whatsapp.net', {
      name: 'Willi Mendoza',
      notify: 'Sr. Willi',
      phone: '51917051504',
    });
    core.repo.upsertContact('test-session', '51955141614@s.whatsapp.net', {
      name: 'Carlos Sanchez',
      phone: '51955141614',
    });

    const { server } = createMcpServer(core);
    const callTool = async (name: string, args: any) => {
      const tool = (server as any)._registeredTools[name];
      if (!tool) throw new Error(`Tool ${name} not found`);
      return tool.handler(args, {});
    };

    // Call dry_run via tool handler
    const dryRunResult = await callTool('broadcast_message', {
      session: 'test-session',
      recipients: [
        '51917051504',
        'Carlos Sanchez',
        '51988888888', // unknown contact name, will use 'Cliente'
        '51917051504', // duplicate recipient
      ],
      message: 'Hola {{name}}, te informamos que tu saldo es {{saldo}}.',
      variables: {
        '51917051504': { saldo: 'S/ 0.00' },
        'Carlos Sanchez': { saldo: 'S/ 50.00' },
      },
      min_delay_seconds: 15,
      max_delay_seconds: 25,
      batch_size: 2,
      cooldown_seconds: 40,
      tag: 'cobranza-test',
      dry_run: true,
    });

    assert.equal(dryRunResult.isError, undefined);
    const dryData = dryRunResult.structuredContent;
    assert.equal(dryData.dry_run, true);
    assert.equal(dryData.summary.valid_recipients, 3);
    assert.equal(dryData.summary.duplicates_skipped, 1);
    assert.equal(dryData.summary.batch_count, 2);
    assert.ok(dryData.warnings.some((w: string) => w.includes('variable {{saldo}} not provided')));
    assert.equal(dryData.timeline_preview.length, 3);

    // Verify nothing was written to DB in dry_run
    assert.equal(core.repo.listScheduled('test-session').length, 0);

    // Execute actual broadcast
    const execResult = await callTool('broadcast_message', {
      session: 'test-session',
      recipients: [
        '51917051504',
        'Carlos Sanchez',
        '51988888888',
      ],
      message: 'Estimado {{first_name}}, recordatorio de pago.',
      min_delay_seconds: 15,
      max_delay_seconds: 20,
      batch_size: 2,
      cooldown_seconds: 30,
      tag: 'campaña-1',
      dry_run: false,
    });

    assert.equal(execResult.isError, undefined);
    const execData = execResult.structuredContent;
    assert.equal(execData.scheduled_count, 3);
    assert.ok(execData.broadcast_id.startsWith('bcast_'));
    assert.equal(execData.tag, 'campaña-1');

    // Verify messages in DB
    const scheduled = core.repo.listScheduled('test-session', undefined, 10, { tag: 'campaña-1' });
    assert.equal(scheduled.length, 3);

    // Verify intervals (t0 is earliest send_at, t2 is latest; listScheduled returns ORDER BY send_at DESC)
    const t0 = scheduled[2]!.send_at;
    const t1 = scheduled[1]!.send_at;
    const t2 = scheduled[0]!.send_at;

    assert.ok(t1 - t0 >= 15, `Interval 1 (${t1 - t0}) should be >= 15s`);
    assert.ok(t2 - t1 >= 45, `Interval 2 with batch cooldown (${t2 - t1}) should be >= 45s`);

    // Test list_scheduled with filter
    const listRes = await callTool('list_scheduled', { session: 'test-session', tag: 'campaña-1' });
    const listData = listRes.structuredContent;
    assert.equal(listData.scheduled.length, 3);
    assert.equal(listData.scheduled[0].tag, 'campaña-1');
    assert.equal(listData.scheduled[0].broadcast_id, execData.broadcast_id);

    // Test cancel_scheduled by broadcast_id
    const cancelRes = await callTool('cancel_scheduled', { broadcast_id: execData.broadcast_id });
    const cancelData = cancelRes.structuredContent;
    assert.equal(cancelData.cancelled_count, 3);

    // Verify all are cancelled
    const remainingPending = core.repo.listScheduled('test-session', 'pending');
    assert.equal(remainingPending.length, 0);
  } finally {
    await core.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
