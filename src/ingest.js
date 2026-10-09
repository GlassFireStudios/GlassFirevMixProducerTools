// Ingest store + MediaMTX auth decisions.
//
// An "ingest" is one inbound feed (e.g. Riverside) with its own stream key. The
// key IS the MediaMTX path suffix: a publisher pushes to rtmp://HOST/live with
// stream key KEY, which lands on path live/KEY. MediaMTX asks the hub (via its
// HTTP auth hook) whether each publish/read is allowed; decideAuth() answers.
//
// Persisted to data/ingests.json (gitignored) with atomic writes. Keys are
// secrets: they never leave the admin API.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { atomicWrite } from './atomic.js';
import { slugify } from './store.js';

const DATA_DIR = path.resolve('data');
const FILE = path.join(DATA_DIR, 'ingests.json');

export const INGEST_APP = 'live';

export function newKey(name) {
  return `${slugify(name).slice(0, 24)}-${crypto.randomBytes(8).toString('hex')}`;
}

export function ingestPath(key) {
  return `${INGEST_APP}/${key}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// IPv4-only CIDR match (the VPC is IPv4). Handles ::ffff:-mapped addresses.
export function ipInCidr(ip, cidr) {
  const toInt = (s) => {
    const parts = String(s).split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
      const v = Number(p);
      if (!Number.isInteger(v) || v < 0 || v > 255 || p === '') return null;
      n = (n * 256) + v;
    }
    return n;
  };
  const addr = toInt(String(ip ?? '').replace(/^::ffff:/i, ''));
  const [base, bitsRaw] = String(cidr).split('/');
  const net = toInt(base);
  const bits = Number(bitsRaw ?? 32);
  if (addr == null || net == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(addr / size) === Math.floor(net / size);
}

/**
 * Decide a MediaMTX auth request.
 * @param {{action:string, path?:string, ip?:string, user?:string, password?:string}} req
 * @param {{ingests:Array<{key:string,enabled:boolean}>, legacy?:{user:string,pass:string}|null, readCidrs:string[]}} ctx
 * @returns {{allow:boolean, reason:string, ingestKey?:string}}
 */
export function decideAuth(req, ctx) {
  const action = req.action;
  const p = String(req.path ?? '');
  const ip = String(req.ip ?? '').replace(/^::ffff:/i, '');
  const loopback = ip === '::1' || ipInCidr(ip, '127.0.0.0/8');

  if (action === 'publish') {
    const legacy = ctx.legacy;
    if (legacy?.user && legacy?.pass && safeEqual(req.user, legacy.user) && safeEqual(req.password, legacy.pass)) {
      return { allow: true, reason: 'legacy-credentials' };
    }
    const prefix = `${INGEST_APP}/`;
    if (p.startsWith(prefix)) {
      const key = p.slice(prefix.length);
      const hit = ctx.ingests.find((i) => i.enabled && safeEqual(i.key, key));
      if (hit) return { allow: true, reason: 'ingest-key', ingestKey: hit.key };
    }
    return { allow: false, reason: 'bad-key' };
  }

  if (action === 'read' || action === 'playback') {
    if (loopback || ctx.readCidrs.some((c) => ipInCidr(ip, c))) return { allow: true, reason: 'trusted-network' };
    return { allow: false, reason: 'untrusted-network' };
  }

  // api / metrics / pprof: MediaMTX only listens for these on localhost.
  if (loopback) return { allow: true, reason: 'loopback' };
  return { allow: false, reason: 'not-allowed' };
}

export class IngestStore extends EventEmitter {
  constructor(file = FILE) {
    super();
    this.file = file;
    this.data = { ingests: [], legacy: null };
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = {
        ingests: Array.isArray(parsed?.ingests) ? parsed.ingests : [],
        legacy: parsed?.legacy ?? null,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this;
  }

  async _persist() {
    await atomicWrite(this.file, JSON.stringify(this.data, null, 2));
    this.emit('change');
  }

  list() { return this.data.ingests.slice(); }
  get legacy() { return this.data.legacy; }
  get(id) { return this.data.ingests.find((i) => i.id === id) || null; }

  _uniqueId(name) {
    const base = slugify(name);
    let id = base;
    for (let n = 2; this.get(id); n += 1) id = `${base}-${n}`;
    return id;
  }

  async create({ name }) {
    const clean = String(name ?? '').trim().slice(0, 60) || 'Ingest';
    const rec = {
      id: this._uniqueId(clean),
      name: clean,
      key: newKey(clean),
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.data.ingests.push(rec);
    await this._persist();
    return rec;
  }

  async update(id, { name, enabled }) {
    const rec = this.get(id);
    if (!rec) return null;
    if (typeof name === 'string' && name.trim()) rec.name = name.trim().slice(0, 60);
    if (typeof enabled === 'boolean') rec.enabled = enabled;
    await this._persist();
    return rec;
  }

  async regenerate(id) {
    const rec = this.get(id);
    if (!rec) return null;
    rec.key = newKey(rec.name);
    rec.rotatedAt = new Date().toISOString();
    await this._persist();
    return rec;
  }

  async remove(id) {
    const before = this.data.ingests.length;
    this.data.ingests = this.data.ingests.filter((i) => i.id !== id);
    if (this.data.ingests.length === before) return false;
    await this._persist();
    return true;
  }
}
