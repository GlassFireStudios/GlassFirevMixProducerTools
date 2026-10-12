// Field machines: GlassFire-owned show computers (NUCs) running a "kit".
//
// A machine is enrolled once with a one-time code (the installer exchanges it for
// a long-lived token, stored on the machine where only SYSTEM/Admins can read it).
// Its agent then polls the kit manifest, pulls changed files, reports a heartbeat,
// and removes GlassFire's kit files once the machine's licence expires.
// Operators reach GlassFire through the Support app (support key, support-only scope).
//
// Persisted to data/field.json; kit files live in data/kits/<kit>/.
// Tokens are stored only as SHA-256 hashes.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWrite } from './atomic.js';

const FILE = path.resolve('data', 'field.json');
export const KITS_DIR = path.resolve('data', 'kits');
export const UPLOADS_DIR = path.resolve('data', 'uploads');
export const UPLOAD_CAP_BYTES = 3 * 1024 ** 3; // hub disk is small; S3 takes over later
const OFFLINE_MS = 5 * 60_000;
const ROLES = ['H', 'V'];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function enrollCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from(crypto.randomBytes(4), (b) => abc[b % abc.length]).join('');
  return `${pick()}-${pick()}`;
}

// A path from a manifest must stay inside its kit folder.
export function safeKitPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(s) || /^[a-z]:/i.test(s)) return null;
  return s;
}

export function isExpired(machine, now = Date.now()) {
  return !!machine.revoked || (!!machine.expiresAt && Date.parse(machine.expiresAt) <= now);
}

// The manifest one machine sees: only its role's files, plus its licence.
export function manifestFor(kit, machine, now = Date.now()) {
  const pick = (list) => (list || []).filter((f) => !f.role || f.role === 'all' || f.role === machine.role);
  return {
    kit: kit.kit, version: kit.version, root: kit.root,
    files: pick(kit.files).map(({ path: p, sha256, size, apply, owned }) => ({ path: p, sha256, size, apply, owned: owned !== false })),
    media: pick(kit.media).map(({ path: p, sha256, size, url }) => ({ path: p, sha256, size, url: url || '' })),
    startup: kit.startup?.[machine.role] || '',
    agent: kit.agent || null,
    licence: { expiresAt: machine.expiresAt || '', revoked: !!machine.revoked, expired: isExpired(machine, now) },
    machine: { id: machine.id, name: machine.name, role: machine.role },
  };
}

export class Field {
  constructor({ notify } = {}) {
    this.data = { machines: [], enroll: [], tickets: [], slackWebhook: '' };
    this.kits = new Map();
    this.notify = notify || (() => {});
  }

  async load() {
    try { this.data = { ...this.data, ...JSON.parse(await fs.readFile(FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await this.loadKits();
    return this;
  }

  _save() { return atomicWrite(FILE, JSON.stringify(this.data, null, 2)); }

  // ---- kits ---------------------------------------------------------------------
  // data/kits/<kit>/manifest.json is written by scripts/kit-publish.mjs, with each
  // file's sha256 already computed; files sit beside it under files/.
  // Pick up a newly published kit without a restart (checked at most every 10 s).
  async refreshKits() {
    if (Date.now() - (this._kitsCheckedAt || 0) < 10_000) return;
    this._kitsCheckedAt = Date.now();
    await this.loadKits();
  }

  // The raw kit entry (with its stored path) for a file this machine may fetch.
  kitEntry(kitId, machine, rel) {
    const kit = this.kits.get(kitId);
    if (!kit) return null;
    return (kit.files || []).find((f) => f.path === rel && (!f.role || f.role === 'all' || f.role === machine.role)) || null;
  }

  async loadKits() {
    this.kits.clear();
    let dirs = [];
    try { dirs = await fs.readdir(KITS_DIR); } catch { return; }
    for (const d of dirs) {
      try {
        const m = JSON.parse(await fs.readFile(path.join(KITS_DIR, d, 'manifest.json'), 'utf8'));
        if (m.kit === d) this.kits.set(d, m);
      } catch { /* not a kit */ }
    }
  }

  kitFilePath(kitId, rel) {
    const p = safeKitPath(rel);
    if (!p) return null;
    return path.join(KITS_DIR, kitId, 'files', ...p.split('/'));
  }

  // ---- machines -----------------------------------------------------------------
  list() { return this.data.machines; }
  get(id) { return this.list().find((m) => m.id === id) || null; }

  publicMachine(m, now = Date.now()) {
    const { tokenHash, supportKeyHash, ...rest } = m;
    return { ...rest, online: !!m.lastSeen && now - m.lastSeen < OFFLINE_MS, expired: isExpired(m, now), enrolled: !!tokenHash };
  }

  async createMachine({ name, role, kit, expiresAt }) {
    if (!ROLES.includes(role)) throw new Error('Role must be H or V');
    const m = {
      id: rand(9), name: str(name, 60) || `NUC ${role}`, role, kit: str(kit, 40),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : '', revoked: false,
      createdAt: Date.now(), lastSeen: 0, status: null, tokenHash: '', supportKeyHash: '',
    };
    this.list().push(m);
    const code = await this.newEnrollCode(m.id, false);
    await this._save();
    return { machine: this.publicMachine(m), code };
  }

  async newEnrollCode(machineId, save = true) {
    const code = enrollCode();
    this.data.enroll = this.data.enroll.filter((e) => e.machineId !== machineId && e.exp > Date.now());
    this.data.enroll.push({ codeHash: sha(code), machineId, exp: Date.now() + 48 * 3600_000 });
    if (save) await this._save();
    return code;
  }

  async updateMachine(id, patch) {
    const m = this.get(id);
    if (!m) return null;
    if (patch.name != null) m.name = str(patch.name, 60);
    if (patch.role != null && ROLES.includes(patch.role)) m.role = patch.role;
    if (patch.expiresAt !== undefined) m.expiresAt = patch.expiresAt ? new Date(patch.expiresAt).toISOString() : '';
    if (patch.revoked != null) m.revoked = !!patch.revoked;
    if (patch.kit != null) m.kit = str(patch.kit, 40);
    await this._save();
    return this.publicMachine(m);
  }

  async removeMachine(id) {
    const before = this.list().length;
    this.data.machines = this.list().filter((m) => m.id !== id);
    this.data.enroll = this.data.enroll.filter((e) => e.machineId !== id);
    if (this.list().length === before) return false;
    await this._save();
    return true;
  }

  // One-time code -> long-lived machine token + support key. Re-enrolling rotates both.
  async enroll(code, hostname) {
    const h = sha(String(code || '').trim().toUpperCase());
    const e = this.data.enroll.find((x) => safeEq(x.codeHash, h) && x.exp > Date.now());
    if (!e) return null;
    const m = this.get(e.machineId);
    if (!m) return null;
    const token = rand(32);
    const supportKey = rand(18);
    m.tokenHash = sha(token);
    m.supportKeyHash = sha(supportKey);
    m.hostname = str(hostname, 80);
    m.enrolledAt = Date.now();
    this.data.enroll = this.data.enroll.filter((x) => x !== e);
    await this._save();
    return { machine: m, token, supportKey };
  }

  byToken(token) {
    if (!token) return null;
    const h = sha(token);
    return this.list().find((m) => m.tokenHash && safeEq(m.tokenHash, h)) || null;
  }

  bySupportKey(key) {
    if (!key) return null;
    const h = sha(key);
    return this.list().find((m) => m.supportKeyHash && safeEq(m.supportKeyHash, h)) || null;
  }

  async heartbeat(m, status) {
    const wasOffline = !m.lastSeen || Date.now() - m.lastSeen > OFFLINE_MS;
    const prev = m.status || {};
    m.lastSeen = Date.now();
    m.status = status;
    m.offlineNotified = false;
    await this._save();
    if (wasOffline && m.enrolledAt) this.notify(`:large_green_circle: *${m.name}* is online${status.vmix?.preset ? ` · vMix: ${status.vmix.preset.split(/[\\/]/).pop()}` : ''}`);
    if (prev.vmix && status.vmix) {
      if (prev.vmix.streaming && !status.vmix.streaming) this.notify(`:red_circle: *${m.name}* stopped streaming`);
      if (!prev.vmix.streaming && status.vmix.streaming) this.notify(`:satellite_antenna: *${m.name}* is streaming`);
      if (prev.vmix.running && !status.vmix.running) this.notify(`:warning: *${m.name}*: vMix is not running`);
    }
    if (!prev.expiredApplied && status.expiredApplied) this.notify(`:lock: *${m.name}*: licence ended, kit files removed`);
  }

  // Called every minute: tell Slack once when a machine goes quiet.
  async sweep(now = Date.now()) {
    let dirty = false;
    for (const m of this.list()) {
      if (m.enrolledAt && m.lastSeen && now - m.lastSeen > OFFLINE_MS && !m.offlineNotified && !isExpired(m, now)) {
        m.offlineNotified = true;
        dirty = true;
        this.notify(`:red_circle: *${m.name}* has not checked in for ${Math.round((now - m.lastSeen) / 60000)} min`);
      }
    }
    if (dirty) await this._save();
  }

  // ---- support tickets ----------------------------------------------------------
  tickets(machineId) {
    const all = [...this.data.tickets].sort((a, b) => b.at - a.at);
    return machineId ? all.filter((t) => t.machineId === machineId) : all;
  }
  ticket(id) { return this.data.tickets.find((t) => t.id === id) || null; }

  async createTicket(m, { type, message, contact }) {
    if (!['question', 'bug', 'media'].includes(type)) throw new Error('bad type');
    const t = {
      id: rand(8), machineId: m.id, machineName: m.name, type, message: str(message, 4000), contact: str(contact, 120),
      status: 'open', files: [], replies: [], at: Date.now(),
      context: { kitVersion: m.status?.kitVersion || '', vmix: m.status?.vmix || null },
    };
    if (!t.message && type !== 'media') throw new Error('Write a message');
    this.data.tickets.push(t);
    await this._save();
    const label = { question: 'Question', bug: 'Problem', media: 'New media' }[type];
    this.notify(`:sos: *${label}* from *${m.name}*${t.contact ? ` (${t.contact})` : ''}\n>${(t.message || '(files only)').slice(0, 600).replace(/\n/g, '\n>')}`);
    return t;
  }

  async addFile(t, name, size) {
    const clean = str(name, 120).replace(/[^\w .()-]/g, '_') || 'file';
    let f = t.files.find((x) => x.name === clean);
    if (!f) { f = { name: clean, size: 0, done: false }; t.files.push(f); }
    f.size = size;
    await this._save();
    return f;
  }

  async reply(t, text, by) {
    t.replies.push({ at: Date.now(), by: str(by, 40), text: str(text, 4000) });
    await this._save();
    return t;
  }

  async setTicketStatus(t, status) {
    t.status = status === 'done' ? 'done' : 'open';
    await this._save();
    return t;
  }

  async setSlack(url) {
    const u = str(url, 300);
    if (u && !/^https:\/\/hooks\.slack\.com\/services\/[\w/]+$/.test(u)) throw new Error('That is not a Slack incoming webhook URL');
    this.data.slackWebhook = u;
    await this._save();
  }
}

export async function uploadsBytes() {
  let total = 0;
  async function walk(d) {
    let ents = [];
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else total += (await fs.stat(p)).size;
    }
  }
  await walk(UPLOADS_DIR);
  return total;
}
