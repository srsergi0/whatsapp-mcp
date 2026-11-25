import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { Core } from '../core.js';
import { loadConfig } from '../config.js';
import { createMcpServer } from '../mcp/server.js';

test('HealthGuard detects cold vs warm recipients and calculates risk metrics', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-health-'));
  const cfg = { ...loadConfig(), dataDir: dir, dbPath: path.join(dir, 'test.db'), mediaDir: path.join(dir, 'media'), logDir: path.join(dir, 'logs') };
  const core = new Core(cfg, pino({ level: 'silent' }));

  try {
    core.createSession('test-sess');
    const now = Math.floor(Date.now() / 1000);

    const baseMsg: any = {
      type: 'text',
      caption: null,
      quoted_id: null,
      quoted_sender: null,
      quoted_text: null,
      quoted_type: null,
      mentions: [],
      forwarded: false,
      status: null,
      ephemeral_expiration: null,
      media_mime: null,
      media_name: null,
      media_size: null,
      media_seconds: null,
      extra: null,
      raw: null,
      has_media: false,
    };

    // Chat A: WARM (inbound exists)
    core.repo.upsertMessage('test-sess', { ...baseMsg, chat_jid: '111@s.whatsapp.net', id: 'm1', ts: now - 300, from_me: false, sender_jid: '111@s.whatsapp.net', text: 'Hola' });
    core.repo.upsertMessage('test-sess', { ...baseMsg, chat_jid: '111@s.whatsapp.net', id: 'm2', ts: now - 200, from_me: true, text: 'Hola, en qué te ayudo?' });

    // Chat B: COLD (only outbound exists)
    core.repo.upsertMessage('test-sess', { ...baseMsg, chat_jid: '222@s.whatsapp.net', id: 'm3', ts: now - 100, from_me: true, text: 'Promoción especial' });

    // Chat C: Group (never cold)
    const groupJid = '1203630@g.us';

    assert.equal(core.healthGuard.isColdRecipient('test-sess', '111@s.whatsapp.net'), false, 'Warm chat with inbound should not be cold');
    assert.equal(core.healthGuard.isColdRecipient('test-sess', '222@s.whatsapp.net'), true, 'Outbound-only chat should be cold');
    assert.equal(core.healthGuard.isColdRecipient('test-sess', groupJid), false, 'Groups should never be cold');

    // Metrics check
    const m1h = core.healthGuard.getWindowMetrics('test-sess', 3600);
    assert.equal(m1h.inbound, 1);
    assert.equal(m1h.outbound, 2);
    assert.equal(m1h.cold_chats, 1);
    assert.equal(m1h.warm_chats, 1);

    // Report check
    const report = core.healthGuard.getReport('test-sess');
    assert.equal(report.session, 'test-sess');
    assert.ok(report.risk_score >= 0 && report.risk_score <= 100);
    assert.equal(report.circuit_breaker.tripped, false);
    assert.ok(report.meta_algorithm_diagnostics.length > 0);
  } finally {
    await core.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('Circuit breaker trips and blocks cold outreach while allowing warm replies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cb-'));
  const cfg = { ...loadConfig(), dataDir: dir, dbPath: path.join(dir, 'test.db'), mediaDir: path.join(dir, 'media'), logDir: path.join(dir, 'logs') };
  const core = new Core(cfg, pino({ level: 'silent' }));

  try {
    core.createSession('test-sess');
    const now = Math.floor(Date.now() / 1000);

    const baseMsg: any = {
      type: 'text',
      caption: null,
      quoted_id: null,
      quoted_sender: null,
      quoted_text: null,
      quoted_type: null,
      mentions: [],
      forwarded: false,
      status: null,
      ephemeral_expiration: null,
      media_mime: null,
      media_name: null,
      media_size: null,
      media_seconds: null,
      extra: null,
      raw: null,
      has_media: false,
    };

    // Chat A is warm
    core.repo.upsertMessage('test-sess', { ...baseMsg, chat_jid: 'warm@s.whatsapp.net', id: 'm1', ts: now - 50, from_me: false, sender_jid: 'warm@s.whatsapp.net', text: 'Buenas' });

    // Manually trip the circuit breaker
    core.healthGuard.tripCircuitBreaker('test-sess', 'Simulated Meta Error 463 Reachout Timelock');

    const cbState = core.healthGuard.getCircuitBreakerState('test-sess');
    assert.equal(cbState.tripped, true);
    assert.ok(cbState.reason?.includes('463'));

    // Cold recipient check must throw
    assert.throws(
      () => core.healthGuard.assertCanSend('test-sess', 'cold_target@s.whatsapp.net'),
      /CIRCUIT BREAKER ACTIVE/,
      'Sending to cold recipient must be refused while circuit breaker is tripped',
    );

    // Warm recipient check must pass
    const warmCheck = core.healthGuard.assertCanSend('test-sess', 'warm@s.whatsapp.net');
    assert.equal(warmCheck.allowed, true);
    assert.equal(warmCheck.is_cold, false);

    // Tool execution test via MCP server
    const { server } = createMcpServer(core);
    const callTool = async (name: string, args: any) => {
      const tool = (server as any)._registeredTools[name];
      if (!tool) throw new Error(`Tool ${name} not found`);
      return tool.handler(args, {});
    };

    // account_health tool
    const healthRes = await callTool('account_health', { session: 'test-sess' });
    const healthData = healthRes.structuredContent;
    assert.equal(healthData.health_status, 'circuit_breaker_tripped');
    assert.equal(healthData.circuit_breaker.tripped, true);

    // configure_health_guard with reset_circuit_breaker
    const resetRes = await callTool('configure_health_guard', {
      session: 'test-sess',
      reset_circuit_breaker: true,
      max_cold_per_hour: 30,
    });
    const resetData = resetRes.structuredContent;
    assert.equal(resetData.config.max_cold_per_hour, 30);
    assert.equal(resetData.circuit_breaker.tripped, false);

    // Now cold recipient should be allowed
    const afterReset = core.healthGuard.assertCanSend('test-sess', 'cold_target@s.whatsapp.net');
    assert.equal(afterReset.allowed, true);
  } finally {
    await core.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
