// Connection store — the source of truth for vMix connections.
//
// Replaces the old static config.json. Persisted to data/connections.json with
// atomic writes (temp file + rename) so a crash mid-write can't corrupt it.
// Emits 'change' on every mutation so the poller can re-sync live (no restart).

import { promises as fs } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { atomicWrite } from './atomic.js';

const DATA_DIR = path.resolve('data');
const FILE = path.join(DATA_DIR, 'connections.json');
const LEGACY_CONFIG = path.resolve('config.json');

const PALETTE = ['#3aa0ff', '#ff5da2', '#28d17c', '#ffb13a', '#9b7bff', '#ff6b6b', '#28c9d1', '#d1c728'];

export function slugify(label) {
  const base = String(label ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'vmix';
}

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export class ConnectionStore extends EventEmitter {
  constructor() {
    super();
    /** @type {Array<object>} */
    this.connections = [];
    this._loaded = false;
  }

  async load() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      const raw = await fs.readFile(FILE, 'utf8');
      const parsed = JSON.parse(raw);
      this.connections = Array.isArray(parsed?.connections) ? parsed.connections : [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.connections = [];
    }

    // First-run migration: if the store is empty, pull in the legacy config.json.
    if (this.connections.length === 0) {
      const migrated = await this._migrateLegacy();
      if (migrated.length) {
        this.connections = migrated;
        await this._persist();
      }
    }

    this._loaded = true;
    return this.connections;
  }

  async _migrateLegacy() {
    let raw;
    try {
      raw = await fs.readFile(LEGACY_CONFIG, 'utf8');
    } catch {
      return [];
    }
    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch {
      return [];
    }
    const list = Array.isArray(cfg?.streams) ? cfg.streams : [];
    const out = [];
    const used = new Set();
    list.forEach((s, i) => {
      const rec = this._normalize(s, out, used);
      rec.order = i;
      out.push(rec);
      used.add(rec.id);
    });
    if (out.length) {
      // eslint-disable-next-line no-console
      console.log(`[store] migrated ${out.length} connection(s) from legacy config.json`);
    }
    return out;
  }

  _uniqueId(label, existing, used) {
    const base = slugify(label);
    let id = base;
    let n = 2;
    const taken = new Set([...(existing ?? []).map((c) => c.id), ...(used ?? [])]);
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  // Build a clean, fully-defaulted record from arbitrary input.
  _normalize(input, existing = this.connections, used = new Set()) {
    const label = String(input.label ?? input.host ?? 'vMix').trim() || 'vMix';
    const order = Number.isFinite(input.order) ? input.order : existing.length;
    const colorIdx = existing.length % PALETTE.length;
    return {
      id: input.id && !used.has(input.id) ? input.id : this._uniqueId(label, existing, used),
      label,
      color: typeof input.color === 'string' && input.color ? input.color : PALETTE[colorIdx],
      host: String(input.host ?? '').trim(),
      port: clampInt(input.port, 8088, 1, 65535),
      username: input.username ? String(input.username) : '',
      password: input.password ? String(input.password) : '',
      input: input.input != null && String(input.input).trim() !== '' ? String(input.input).trim() : 'active',
      warnSeconds: clampInt(input.warnSeconds, 30, 0, 86400),
      dangerSeconds: clampInt(input.dangerSeconds, 10, 0, 86400),
      enabled: input.enabled !== false,
      order,
    };
  }

  // ---- atomic persistence -------------------------------------------------
  async _persist() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await atomicWrite(FILE, JSON.stringify({ connections: this.connections }, null, 2));
  }

  async _save() {
    await this._persist();
    this.emit('change', this.list());
  }

  // ---- reads --------------------------------------------------------------
  list() {
    return [...this.connections].sort((a, b) => a.order - b.order);
  }

  enabled() {
    return this.list().filter((c) => c.enabled);
  }

  get(id) {
    return this.connections.find((c) => c.id === id) ?? null;
  }

  // ---- mutations ----------------------------------------------------------
  async create(input) {
    const rec = this._normalize(input);
    rec.order = this.connections.length;
    this.connections.push(rec);
    await this._save();
    return rec;
  }

  async update(id, patch) {
    const rec = this.get(id);
    if (!rec) return null;
    // Keep id and order stable; let everything else be patched.
    const merged = this._normalize({ ...rec, ...patch, id: rec.id, order: rec.order }, this.connections.filter((c) => c.id !== id));
    merged.id = rec.id;
    merged.order = rec.order;
    Object.assign(rec, merged);
    await this._save();
    return rec;
  }

  async remove(id) {
    const before = this.connections.length;
    this.connections = this.connections.filter((c) => c.id !== id);
    if (this.connections.length === before) return false;
    // Re-pack order values.
    this.list().forEach((c, i) => { c.order = i; });
    await this._save();
    return true;
  }

  async setEnabled(id, enabled) {
    return this.update(id, { enabled: !!enabled });
  }

  async reorder(ids) {
    const pos = new Map(ids.map((id, i) => [id, i]));
    this.connections.forEach((c) => {
      if (pos.has(c.id)) c.order = pos.get(c.id);
    });
    // Anything not listed keeps a stable spot after the listed ones.
    let tail = pos.size;
    this.list().forEach((c) => { if (!pos.has(c.id)) c.order = tail++; });
    await this._save();
    return this.list();
  }
}

// Public-safe projection for producer routes (no host/creds leaked).
export function publicView(conn) {
  return {
    id: conn.id,
    label: conn.label,
    color: conn.color,
    warnSeconds: conn.warnSeconds,
    dangerSeconds: conn.dangerSeconds,
    input: conn.input,
    order: conn.order,
  };
}
