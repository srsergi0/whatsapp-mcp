import type { Core } from '../core.js';

const now = () => Math.floor(Date.now() / 1000);

export interface HealthConfig {
  enabled: boolean;
  max_cold_per_hour: number;
  max_cold_per_day: number;
  cooldown_minutes: number;
  max_cold_ratio_pct: number;
}

const DEFAULT_CONFIG: HealthConfig = {
  enabled: true,
  max_cold_per_hour: 25,
  max_cold_per_day: 100,
  cooldown_minutes: 45,
  max_cold_ratio_pct: 75,
};

export interface CircuitBreakerState {
  tripped: boolean;
  until: number;
  reason: string | null;
  tripped_at: number | null;
}

export interface WindowMetrics {
  outbound: number;
  inbound: number;
  cold_chats: number;
  warm_chats: number;
}

export interface MetaDiagnostic {
  heuristic: string;
  level: 'ok' | 'warning' | 'critical';
  detail: string;
}

export interface HealthReport {
  session: string;
  health_status: 'healthy' | 'moderate_risk' | 'high_risk' | 'circuit_breaker_tripped';
  risk_score: number;
  circuit_breaker: {
    tripped: boolean;
    remaining_cooldown_seconds: number;
    remaining_cooldown_minutes: number;
    reason: string | null;
  };
  metrics_1h: WindowMetrics;
  metrics_24h: WindowMetrics;
  ratios: {
    outbound_to_inbound_ratio: string;
    cold_outreach_percentage: string;
  };
  limits: HealthConfig;
  meta_algorithm_diagnostics: MetaDiagnostic[];
  recommendations: string[];
}

export class HealthGuard {
  constructor(private readonly core: Core) {}

  getConfig(session: string): HealthConfig {
    const raw = this.core.repo.kvGet(`health_cfg:${session}`);
    if (!raw) return { ...DEFAULT_CONFIG };
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  updateConfig(session: string, patch: Partial<HealthConfig>): HealthConfig {
    const cur = this.getConfig(session);
    const updated = { ...cur, ...patch };
    this.core.repo.kvSet(`health_cfg:${session}`, JSON.stringify(updated));
    return updated;
  }

  getCircuitBreakerState(session: string): CircuitBreakerState {
    const raw = this.core.repo.kvGet(`health_cb:${session}`);
    if (!raw) return { tripped: false, until: 0, reason: null, tripped_at: null };
    try {
      const state: CircuitBreakerState = JSON.parse(raw);
      const currentTs = now();
      if (state.tripped && state.until <= currentTs) {
        // Automatically expired
        this.resetCircuitBreaker(session);
        return { tripped: false, until: 0, reason: null, tripped_at: null };
      }
      return state;
    } catch {
      return { tripped: false, until: 0, reason: null, tripped_at: null };
    }
  }

  tripCircuitBreaker(session: string, reason: string): CircuitBreakerState {
    const cfg = this.getConfig(session);
    const currentTs = now();
    const until = currentTs + cfg.cooldown_minutes * 60;
    const state: CircuitBreakerState = {
      tripped: true,
      until,
      reason,
      tripped_at: currentTs,
    };
    this.core.repo.kvSet(`health_cb:${session}`, JSON.stringify(state));
    this.core.publish(session, 'health.circuit_breaker_tripped', null, null, {
      session,
      reason,
      cooldown_minutes: cfg.cooldown_minutes,
      until,
    });
    this.core.repo.audit('circuit_breaker_trip', session, null, false, reason);
    return state;
  }

  resetCircuitBreaker(session: string): void {
    this.core.repo.kvSet(`health_cb:${session}`, JSON.stringify({ tripped: false, until: 0, reason: null, tripped_at: null }));
    this.core.publish(session, 'health.circuit_breaker_reset', null, null, { session });
    this.core.repo.audit('circuit_breaker_reset', session, null, true, 'Circuit breaker reset');
  }

  /**
   * Returns true if the recipient has NEVER sent an incoming message to this session.
   * Groups and status broadcast are never considered cold.
   */
  isColdRecipient(session: string, jid: string): boolean {
    if (jid.endsWith('@g.us') || jid.startsWith('status@')) return false;
    const row = this.core.db.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM messages WHERE session = ? AND chat_jid = ? AND from_me = 0 LIMIT 1',
      session,
      jid,
    );
    return (row?.c ?? 0) === 0;
  }

  /**
   * Query window metrics for outbound, inbound, cold outreach and warm chats.
   */
  getWindowMetrics(session: string, windowSeconds: number): WindowMetrics {
    const since = now() - windowSeconds;

    const outRow = this.core.db.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM messages WHERE session = ? AND from_me = 1 AND ts >= ?',
      session,
      since,
    );
    const inRow = this.core.db.get<{ c: number }>(
      'SELECT COUNT(*) as c FROM messages WHERE session = ? AND from_me = 0 AND ts >= ?',
      session,
      since,
    );

    // Distinct cold chats contacted in this window
    const coldRow = this.core.db.get<{ c: number }>(
      `SELECT COUNT(DISTINCT chat_jid) as c
       FROM messages m
       WHERE m.session = ?
         AND m.from_me = 1
         AND m.ts >= ?
         AND m.chat_jid NOT LIKE '%@g.us'
         AND m.chat_jid NOT LIKE 'status@%'
         AND NOT EXISTS (
           SELECT 1 FROM messages in_m
           WHERE in_m.session = m.session
             AND in_m.chat_jid = m.chat_jid
             AND in_m.from_me = 0
         )`,
      session,
      since,
    );

    // Distinct warm chats contacted in this window
    const warmRow = this.core.db.get<{ c: number }>(
      `SELECT COUNT(DISTINCT chat_jid) as c
       FROM messages m
       WHERE m.session = ?
         AND m.from_me = 1
         AND m.ts >= ?
         AND (
           m.chat_jid LIKE '%@g.us'
           OR EXISTS (
             SELECT 1 FROM messages in_m
             WHERE in_m.session = m.session
               AND in_m.chat_jid = m.chat_jid
               AND in_m.from_me = 0
           )
         )`,
      session,
      since,
    );

    return {
      outbound: outRow?.c ?? 0,
      inbound: inRow?.c ?? 0,
      cold_chats: coldRow?.c ?? 0,
      warm_chats: warmRow?.c ?? 0,
    };
  }

  /**
   * Calculate Meta Risk Score (0 - 100) and diagnostics based on reverse-engineered heuristics:
   * 1. Cold velocity / 1 hour
   * 2. Cold volume / 24 hours
   * 3. Traffic asymmetry (outbound vs inbound ratio)
   * 4. Inbound conversation credit (recovery mechanism)
   */
  getReport(session: string): HealthReport {
    const cfg = this.getConfig(session);
    const cb = this.getCircuitBreakerState(session);
    const m1h = this.getWindowMetrics(session, 3600);
    const m24h = this.getWindowMetrics(session, 86400);

    let riskScore = 0;
    const diagnostics: MetaDiagnostic[] = [];
    const recommendations: string[] = [];

    // --- Heuristic 1: Cold velocity in 1h (Max threshold e.g. 25) ---
    const cold1hPct = (m1h.cold_chats / Math.max(1, cfg.max_cold_per_hour)) * 100;
    if (m1h.cold_chats >= cfg.max_cold_per_hour) {
      riskScore += 50;
      diagnostics.push({
        heuristic: 'Cold Outreach Velocity (1h)',
        level: 'critical',
        detail: `Exceeded hourly threshold: ${m1h.cold_chats} cold chats in last 60m (limit: ${cfg.max_cold_per_hour}). High risk of Error 463 Reachout Timelock.`,
      });
    } else if (m1h.cold_chats >= cfg.max_cold_per_hour * 0.6) {
      riskScore += 30;
      diagnostics.push({
        heuristic: 'Cold Outreach Velocity (1h)',
        level: 'warning',
        detail: `Elevated cold outreach velocity: ${m1h.cold_chats}/${cfg.max_cold_per_hour} cold chats in last 60m (${Math.round(cold1hPct)}%). Slow down bursts.`,
      });
    } else {
      diagnostics.push({
        heuristic: 'Cold Outreach Velocity (1h)',
        level: 'ok',
        detail: `Velocity is safe: ${m1h.cold_chats} cold chats in last 60m (safe limit: ${cfg.max_cold_per_hour}).`,
      });
    }

    // --- Heuristic 2: Cold volume in 24h (Max threshold e.g. 100) ---
    const cold24hPct = (m24h.cold_chats / Math.max(1, cfg.max_cold_per_day)) * 100;
    if (m24h.cold_chats >= cfg.max_cold_per_day) {
      riskScore += 35;
      diagnostics.push({
        heuristic: 'Daily Cold Reachout (24h)',
        level: 'critical',
        detail: `Daily cold volume exceeded: ${m24h.cold_chats}/${cfg.max_cold_per_day} in 24h. Meta spam heuristics trigger automated shadow-bans at this scale.`,
      });
    } else if (m24h.cold_chats >= cfg.max_cold_per_day * 0.65) {
      riskScore += 20;
      diagnostics.push({
        heuristic: 'Daily Cold Reachout (24h)',
        level: 'warning',
        detail: `Daily cold volume is moderate-high: ${m24h.cold_chats}/${cfg.max_cold_per_day} (${Math.round(cold24hPct)}%).`,
      });
    } else {
      diagnostics.push({
        heuristic: 'Daily Cold Reachout (24h)',
        level: 'ok',
        detail: `Daily cold outreach is healthy: ${m24h.cold_chats}/${cfg.max_cold_per_day} in 24h.`,
      });
    }

    // --- Heuristic 3: Outbound/Inbound Asymmetry & Block Risk ---
    const total24hChats = m24h.cold_chats + m24h.warm_chats;
    const coldRatioPct = total24hChats > 0 ? Math.round((m24h.cold_chats / total24hChats) * 100) : 0;
    const outToInRatio = m24h.inbound > 0 ? (m24h.outbound / m24h.inbound).toFixed(1) : (m24h.outbound > 0 ? `${m24h.outbound}:0` : '1.0');

    if (m24h.outbound >= 15 && m24h.inbound === 0) {
      riskScore += 25;
      diagnostics.push({
        heuristic: 'Traffic Asymmetry (Outbound vs Inbound)',
        level: 'critical',
        detail: `Zero incoming replies (${m24h.outbound} sent, 0 received in 24h). Pure unidirectional traffic is the primary signal Meta uses to detect spam bots.`,
      });
    } else if (m24h.outbound >= 25 && Number(outToInRatio) > 5) {
      riskScore += 15;
      diagnostics.push({
        heuristic: 'Traffic Asymmetry (Outbound vs Inbound)',
        level: 'warning',
        detail: `Heavy outbound skew (${outToInRatio}:1). Meta algorithms score accounts with high incoming reply rates much safer.`,
      });
    } else {
      diagnostics.push({
        heuristic: 'Traffic Asymmetry (Outbound vs Inbound)',
        level: 'ok',
        detail: `Healthy conversation ratio (${m24h.outbound} sent vs ${m24h.inbound} received in 24h).`,
      });
    }

    // --- Heuristic 4: Inbound Engagement Credit (Recovery Mechanism) ---
    // Receiving messages from customers actively recovers account trust score
    if (m24h.inbound > 0) {
      const credit = Math.min(20, Math.floor(m24h.inbound * 1.2));
      riskScore = Math.max(0, riskScore - credit);
    }

    // Final score clamp
    riskScore = Math.min(100, Math.max(0, riskScore));

    // Determine status & auto-trip check
    let status: HealthReport['health_status'] = 'healthy';
    if (cb.tripped) {
      status = 'circuit_breaker_tripped';
    } else if (riskScore >= 85 || m1h.cold_chats >= cfg.max_cold_per_hour || m24h.cold_chats >= cfg.max_cold_per_day) {
      // Auto-trip circuit breaker if guard is enabled
      if (cfg.enabled) {
        const tripReason = diagnostics.find((d) => d.level === 'critical')?.detail ?? `Risk score reached critical level (${riskScore}/100)`;
        this.tripCircuitBreaker(session, tripReason);
        status = 'circuit_breaker_tripped';
      } else {
        status = 'high_risk';
      }
    } else if (riskScore >= 60) {
      status = 'high_risk';
    } else if (riskScore >= 35) {
      status = 'moderate_risk';
    }

    // Build recommendations
    if (status === 'circuit_breaker_tripped') {
      recommendations.push(
        'Circuit breaker is TRIPPED: All sends to new/cold numbers are blocked until cooldown expires to prevent account ban.',
        'Replies to existing conversations in "inbox" are STILL ALLOWED and actively help restore your reputation with Meta.',
        'If you must bypass, call configure_health_guard { reset_circuit_breaker: true }.',
      );
    } else {
      if (m1h.cold_chats >= cfg.max_cold_per_hour * 0.7) {
        recommendations.push('Pause cold outreach for 30 minutes to allow the rolling hourly velocity counter to cool down.');
      }
      if (coldRatioPct > 50) {
        recommendations.push('More than 50% of your messaged chats have no prior history. Ask customers to write first (via web link or QR) to establish trusted tctoken tokens.');
      }
      if (recommendations.length === 0) {
        recommendations.push('Account metrics are within optimal human safety parameters. Safe to send broadcasts and direct messages.');
      }
    }

    const remainingSec = cb.tripped ? Math.max(0, cb.until - now()) : 0;

    return {
      session,
      health_status: status,
      risk_score: riskScore,
      circuit_breaker: {
        tripped: cb.tripped && remainingSec > 0,
        remaining_cooldown_seconds: remainingSec,
        remaining_cooldown_minutes: Math.ceil(remainingSec / 60),
        reason: cb.reason,
      },
      metrics_1h: m1h,
      metrics_24h: m24h,
      ratios: {
        outbound_to_inbound_ratio: `${outToInRatio}:1`,
        cold_outreach_percentage: `${coldRatioPct}%`,
      },
      limits: cfg,
      meta_algorithm_diagnostics: diagnostics,
      recommendations,
    };
  }

  /**
   * Pre-flight check before sending any message.
   * If recipient is WARM (already messaged us or group): ALWAYS ALLOWED.
   * If recipient is COLD and circuit breaker is TRIPPED: REFUSED.
   */
  assertCanSend(session: string, recipientJid: string): { allowed: boolean; is_cold: boolean; message?: string } {
    const isCold = this.isColdRecipient(session, recipientJid);
    if (!isCold) {
      return { allowed: true, is_cold: false };
    }

    const cfg = this.getConfig(session);
    if (!cfg.enabled) {
      return { allowed: true, is_cold: true };
    }

    const cb = this.getCircuitBreakerState(session);
    if (cb.tripped) {
      const remainingMin = Math.ceil(Math.max(0, cb.until - now()) / 60);
      const msg = `CIRCUIT BREAKER ACTIVE [Meta Ban Protection]: Outbound messaging to new/cold numbers is currently paused for session "${session}" to prevent an automated ban by Meta. ${remainingMin}m remaining in cooldown. Reason: ${cb.reason ?? 'High risk score'}. Replying to existing conversations is still allowed. Use account_health to inspect or configure_health_guard { reset_circuit_breaker: true } if you need to override.`;
      throw new Error(msg);
    }

    // Pre-check if current send would breach hourly limit
    const m1h = this.getWindowMetrics(session, 3600);
    if (m1h.cold_chats >= cfg.max_cold_per_hour) {
      const tripReason = `Hourly cold outreach limit reached (${m1h.cold_chats}/${cfg.max_cold_per_hour})`;
      this.tripCircuitBreaker(session, tripReason);
      const msg = `CIRCUIT BREAKER TRIPPED [Meta Ban Protection]: Hourly limit of ${cfg.max_cold_per_hour} cold contacts reached. Tripping breaker for ${cfg.cooldown_minutes}m to protect the account from WhatsApp suspension.`;
      throw new Error(msg);
    }

    return { allowed: true, is_cold: true };
  }

  /**
   * Check capacity before launching a broadcast.
   */
  checkBroadcastCapacity(session: string, targetCount: number): { safe: boolean; cold_estimate: number; warning?: string } {
    const cfg = this.getConfig(session);
    if (!cfg.enabled) return { safe: true, cold_estimate: 0 };

    const cb = this.getCircuitBreakerState(session);
    if (cb.tripped) {
      const remainingMin = Math.ceil(Math.max(0, cb.until - now()) / 60);
      return {
        safe: false,
        cold_estimate: targetCount,
        warning: `Circuit breaker is currently TRIPPED (${remainingMin}m remaining). Any cold recipients in this broadcast will be blocked.`,
      };
    }

    const m1h = this.getWindowMetrics(session, 3600);
    const availableCold = Math.max(0, cfg.max_cold_per_hour - m1h.cold_chats);
    if (targetCount > availableCold) {
      return {
        safe: false,
        cold_estimate: targetCount,
        warning: `Broadcast size (${targetCount}) may exceed remaining hourly safe cold allowance (${availableCold} left of ${cfg.max_cold_per_hour}). Recommend using batch_size <= 5 and min_delay_seconds >= 25.`,
      };
    }

    return { safe: true, cold_estimate: targetCount };
  }
}
