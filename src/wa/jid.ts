import { jidNormalizedUser } from 'baileys';

export type ChatKind = 'user' | 'group' | 'newsletter' | 'broadcast' | 'community';

export const STATUS_JID = 'status@broadcast';

export function bare(jid: string | null | undefined): string {
  if (!jid) return '';
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid;
  }
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}
export function isLidJid(jid: string): boolean {
  return jid.endsWith('@lid');
}
export function isPnJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net');
}
export function isNewsletterJid(jid: string): boolean {
  return jid.endsWith('@newsletter');
}
export function isBroadcastJid(jid: string): boolean {
  return jid.endsWith('@broadcast');
}

export function kindOf(jid: string): ChatKind {
  if (isGroupJid(jid)) return 'group';
  if (isNewsletterJid(jid)) return 'newsletter';
  if (isBroadcastJid(jid)) return 'broadcast';
  return 'user';
}

/** Digits of a PN jid (or undefined for lid/group/etc). */
export function phoneOf(jid: string | null | undefined): string | undefined {
  if (!jid) return undefined;
  const b = bare(jid);
  return isPnJid(b) ? b.split('@')[0] : undefined;
}

/**
 * Accepts: "+54 9 11 1234-5678", "5491112345678", "5491112345678@s.whatsapp.net",
 * "1203630...@g.us", "...@lid", "...@newsletter", "status@broadcast".
 * Throws on anything else (names are resolved elsewhere).
 */
export function toJid(input: string): string {
  const v = String(input ?? '').trim();
  if (!v) throw new Error('Empty jid / phone number');
  if (v.includes('@')) {
    const [user, server] = v.split('@') as [string, string];
    if (!user || !server) throw new Error(`Invalid jid: ${input}`);
    // keep group / newsletter / broadcast untouched; strip device suffix from user jids
    if (server === 'g.us' || server === 'newsletter' || server === 'broadcast') return v;
    return bare(v);
  }
  const digits = v.replace(/[\s\-().+]/g, '');
  if (/^\d{7,15}$/.test(digits)) return `${digits}@s.whatsapp.net`;
  throw new Error(`Not a phone number or jid: "${input}". Use digits with country code (e.g. 5491112345678) or a full jid.`);
}

export function looksLikeJidOrPhone(input: string): boolean {
  try {
    toJid(input);
    return true;
  } catch {
    return false;
  }
}

export function normalizePhone(input: string): string {
  const digits = String(input).replace(/\D/g, '');
  if (!/^\d{7,15}$/.test(digits)) {
    throw new Error(`Invalid phone number "${input}": need 7-15 digits including country code, no leading 0 or +.`);
  }
  return digits;
}
