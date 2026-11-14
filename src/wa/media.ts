import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Config } from '../config.js';

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', '3gp': 'video/3gpp', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg; codecs=opus', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', amr: 'audio/amr', flac: 'audio/flac',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  html: 'text/html', md: 'text/markdown', xml: 'application/xml', vcf: 'text/vcard', apk: 'application/vnd.android.package-archive',
};

export function mimeFromName(name: string): string | undefined {
  const ext = path.extname(name.split('?')[0]!).slice(1).toLowerCase();
  return EXT_MIME[ext];
}

export function extFromMime(mime?: string | null): string {
  if (!mime) return 'bin';
  const base = mime.split(';')[0]!.trim().toLowerCase();
  if (base === 'audio/ogg') return 'ogg';
  if (base === 'audio/mpeg') return 'mp3';
  if (base === 'audio/mp4') return 'm4a';
  if (base === 'video/quicktime') return 'mov';
  if (base === 'text/plain') return 'txt';
  for (const [ext, m] of Object.entries(EXT_MIME)) if (m.split(';')[0] === base) return ext;
  return base.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin';
}

export function sniffMime(b: Buffer): string | undefined {
  if (b.length < 12) return undefined;
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (b.subarray(4, 8).toString() === 'ftyp') return b.subarray(8, 12).toString().startsWith('M4A') ? 'audio/mp4' : 'video/mp4';
  if (b.subarray(0, 4).toString() === 'OggS') return 'audio/ogg; codecs=opus';
  if (b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (b.subarray(0, 2).toString() === 'PK') return 'application/zip';
  return undefined;
}

/* ---------------------------------- guards ---------------------------------- */

const DENY_SEGMENTS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.git-credentials'];
const DENY_NAMES = [/^\.env/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /\.(pem|key|pfx|p12|kdbx|ppk)$/i, /^\.npmrc$/i, /^\.netrc$/i, /^creds\.json$/i, /^whatsapp\.db/i, /^login data$/i, /^cookies$/i, /^known_hosts$/i];

/** Prevent a prompt-injected agent from exfiltrating secrets through WhatsApp. */
export function assertReadablePath(file: string, cfg: Config): string {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(file));
  } catch {
    throw new Error(`File not found: ${file}`);
  }
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`Not a file: ${file}`);
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const R = norm(real);
  const inside = (parent: string) => { const p = norm(path.resolve(parent)) + path.sep; return R.startsWith(p); };

  if (cfg.allowedDirs.length && !cfg.allowedDirs.some(inside)) {
    throw new Error(`Path outside WA_MCP_ALLOWED_DIRS: ${file}`);
  }
  const outbox = path.join(cfg.dataDir, 'outbox');
  if (inside(cfg.dataDir) && !inside(cfg.mediaDir) && !inside(outbox)) {
    throw new Error('Refusing to read the server data directory (credentials live there). Put files in <data>/outbox instead.');
  }
  const parts = real.split(path.sep).map((s) => s.toLowerCase());
  if (DENY_SEGMENTS.some((d) => parts.includes(d))) throw new Error(`Refusing to read sensitive location: ${file}`);
  const base = path.basename(real);
  if (DENY_NAMES.some((re) => re.test(base))) throw new Error(`Refusing to send a credential-like file: ${base}`);
  return real;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

async function assertPublicUrl(u: URL, cfg: Config) {
  if (!/^https?:$/.test(u.protocol)) throw new Error(`Only http(s) URLs are allowed: ${u.protocol}`);
  if (cfg.allowPrivateUrls) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error(`Refusing to fetch private/loopback address (${host}). Set WA_MCP_ALLOW_PRIVATE_URLS=1 to allow.`);
}

export async function fetchLimited(url: string, cfg: Config, maxBytes = cfg.mediaMaxBytes): Promise<{ buffer: Buffer; mimetype?: string; fileName?: string }> {
  let cur = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(cur, cfg);
    const res = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'whatsapp-mcp/1.0' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      cur = new URL(res.headers.get('location')!, cur);
      continue;
    }
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${cur.href}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len && len > maxBytes) throw new Error(`File too large: ${len} bytes > limit ${maxBytes}`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`File too large (> ${maxBytes} bytes)`);
      chunks.push(Buffer.from(chunk));
    }
    const ct = res.headers.get('content-type')?.split(';')[0]?.trim();
    const cd = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
    const name = cd ? decodeURIComponent(cd) : path.basename(cur.pathname) || undefined;
    return { buffer: Buffer.concat(chunks), mimetype: ct && ct !== 'application/octet-stream' ? ct : undefined, fileName: name };
  }
  throw new Error('Too many redirects');
}

export interface MediaSource {
  path?: string;
  url?: string;
  base64?: string;
  file_name?: string;
  mimetype?: string;
}

export interface LoadedMedia { buffer: Buffer; mimetype: string; fileName: string }

export async function loadSource(src: MediaSource, cfg: Config): Promise<LoadedMedia> {
  const given = [src.path, src.url, src.base64].filter(Boolean).length;
  if (given !== 1) throw new Error('Provide exactly one of: path, url, base64');
  let buffer: Buffer;
  let mimetype = src.mimetype;
  let fileName = src.file_name;
  if (src.path) {
    const real = assertReadablePath(src.path, cfg);
    const size = (await fsp.stat(real)).size;
    if (size > cfg.mediaMaxBytes * 4) throw new Error(`File too large (${size} bytes)`);
    buffer = await fsp.readFile(real);
    fileName ??= path.basename(real);
    mimetype ??= mimeFromName(real);
  } else if (src.url) {
    const r = await fetchLimited(src.url, cfg, cfg.mediaMaxBytes * 4);
    buffer = r.buffer;
    fileName ??= r.fileName;
    mimetype ??= r.mimetype ?? mimeFromName(src.url);
  } else {
    const b64 = src.base64!.replace(/^data:[^;]+;base64,/, '');
    buffer = Buffer.from(b64, 'base64');
    if (!buffer.length) throw new Error('Empty base64 payload');
    if (buffer.length > cfg.mediaMaxBytes * 4) throw new Error('base64 payload too large');
    const m = /^data:([^;]+);base64,/.exec(src.base64!);
    mimetype ??= m?.[1];
  }
  mimetype ??= sniffMime(buffer) ?? 'application/octet-stream';
  fileName ??= `file-${crypto.randomBytes(3).toString('hex')}.${extFromMime(mimetype)}`;
  return { buffer, mimetype, fileName };
}

/* ---------------------------------- ffmpeg ---------------------------------- */

let ffmpegOk: boolean | undefined;
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegOk !== undefined) return ffmpegOk;
  ffmpegOk = await new Promise<boolean>((res) => {
    try {
      const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
      p.on('error', () => res(false));
      p.on('exit', (c) => res(c === 0));
    } catch { res(false); }
  });
  return ffmpegOk;
}

async function ffmpeg(input: Buffer, inExt: string, args: string[], outExt: string): Promise<Buffer> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wa-mcp-'));
  const inp = path.join(dir, `in.${inExt}`);
  const out = path.join(dir, `out.${outExt}`);
  try {
    await fsp.writeFile(inp, input);
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', inp, ...args, out], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.slice(0, 300)}`))));
    });
    return await fsp.readFile(out);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Voice notes must be opus in an ogg container to render as a PTT bubble. */
export async function toVoiceOpus(m: LoadedMedia): Promise<{ buffer: Buffer; mimetype: string; converted: boolean }> {
  if (/^audio\/ogg/.test(m.mimetype) && /opus/i.test(m.mimetype + (m.fileName.endsWith('.opus') ? 'opus' : ''))) {
    return { buffer: m.buffer, mimetype: 'audio/ogg; codecs=opus', converted: false };
  }
  if (!(await hasFfmpeg())) {
    if (/^audio\/ogg/.test(m.mimetype)) return { buffer: m.buffer, mimetype: 'audio/ogg; codecs=opus', converted: false };
    throw new Error('ffmpeg is required to convert audio into a WhatsApp voice note (install ffmpeg or supply an .ogg/opus file).');
  }
  const buffer = await ffmpeg(m.buffer, extFromMime(m.mimetype), ['-vn', '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-ac', '1', '-ar', '16000'], 'ogg');
  return { buffer, mimetype: 'audio/ogg; codecs=opus', converted: true };
}

/** Static -> sharp; animated (gif / video) -> ffmpeg. Result is a 512x512 webp. */
export async function toStickerWebp(m: LoadedMedia, animated: boolean): Promise<Buffer> {
  if (!animated) {
    const { default: sharp } = await import('sharp');
    return sharp(m.buffer).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80 }).toBuffer();
  }
  if (!(await hasFfmpeg())) throw new Error('ffmpeg is required for animated stickers.');
  const vf = 'fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';
  return ffmpeg(m.buffer, extFromMime(m.mimetype), ['-t', '8', '-vf', vf, '-c:v', 'libwebp', '-lossless', '0', '-q:v', '60', '-loop', '0', '-an'], 'webp');
}

/** Safe on-disk name for chat ids / message ids. */
export function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}
