// vMix machines, vMix Call status, and guest invites.
//
// - Machines: the vMix instances the hub can reach (private IPs in the VPC).
// - Poller:   every 2s reads each machine's /api XML and keeps a snapshot of
//             recording/streaming state, master meters, and every vMix Call
//             input (password, connected, video/audio return source, meters).
// - Invites:  a guest link (/join/<code>) bound to one call input. The guest
//             runs a tech check on our page, then is sent to vmixcall.com with
//             their name and that input's password prefilled.
//
// Call passwords are secrets: they only leave the hub inside the redirect for
// the guest who holds the invite code, or in the admin API.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { atomicWrite } from './atomic.js';
import { slugify } from './store.js';
import { fetchVmixApi, VmixError } from './vmix.js';

const DATA_DIR = path.resolve('data');
const POLL_MS = 2000;

// Keep attribute values as strings: call passwords can have leading zeros.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false });
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const bool = (v) => String(v).toLowerCase() === 'true';
const meterDb = (v) => {
  const n = Number(v);
  return n > 0 ? Math.round(20 * Math.log10(n) * 10) / 10 : null; // vMix meters are linear 0..1
};

export function parseVmixState(xml) {
  const v = parser.parse(xml)?.vmix || {};
  const textOf = (x) => (x && typeof x === 'object' ? x['#text'] : x);
  const inputs = arr(v.inputs?.input);
  const master = v.audio?.master || {};
  return {
    version: String(v.version ?? ''),
    edition: String(v.edition ?? ''),
    preset: v.preset ? String(v.preset).split(/[\\/]/).pop() : null,
    recording: bool(textOf(v.recording)),
    streaming: bool(textOf(v.streaming)),
    external: bool(textOf(v.external)),
    masterDb: [meterDb(master.meterF1), meterDb(master.meterF2)],
    inputCount: inputs.length,
    calls: inputs.filter((i) => String(i.type).toLowerCase() === 'videocall').map((i) => ({
      key: String(i.key),
      number: Number(i.number),
      title: String(i.title ?? ''),
      password: i.callPassword != null ? String(i.callPassword) : null,
      connected: bool(i.callConnected),
      videoSource: i.callVideoSource ?? null,
      audioSource: i.callAudioSource ?? null,
      muted: bool(i.muted),
      db: [meterDb(i.meterF1), meterDb(i.meterF2)],
    })),
  };
}

export function vmixCallUrl(password, name) {
  const q = new URLSearchParams({ Key: String(password), Name: String(name || 'Guest') });
  return `https://www.vmixcall.com/call.aspx?${q}`;
}

export function newInviteCode() {
  // 10 chars of base32 (~50 bits): unguessable, easy to read out over the phone.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

class JsonFile {
  constructor(name, empty) { this.file = path.join(DATA_DIR, name); this.empty = empty; this.data = empty(); }
  async load() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }
  save() { return atomicWrite(this.file, JSON.stringify(this.data, null, 2)); }
}

export class VmixCalls {
  constructor() {
    this.machinesFile = new JsonFile('vmix-machines.json', () => ({ machines: [] }));
    this.invitesFile = new JsonFile('guests.json', () => ({ invites: [] }));
    this.status = new Map(); // machineId -> { reachable, error, ...parseVmixState, at }
    this._timer = null;
  }

  async load() {
    await this.machinesFile.load();
    await this.invitesFile.load();
    return this;
  }

  start() { this._tick(); this._timer = setInterval(() => this._tick(), POLL_MS); }
  stop() { clearInterval(this._timer); }

  // ---- machines -------------------------------------------------------------
  machines() { return this.machinesFile.data.machines; }
  machine(id) { return this.machines().find((m) => m.id === id) || null; }

  async addMachine({ label, host, port = 8088, username = '', password = '' }) {
    let id = slugify(label);
    for (let n = 2; this.machine(id); n += 1) id = `${slugify(label)}-${n}`;
    const m = { id, label: String(label).slice(0, 40), host: String(host).trim(), port: Number(port) || 8088, username, password };
    this.machines().push(m);
    await this.machinesFile.save();
    this._tick();
    return m;
  }

  async updateMachine(id, patch) {
    const m = this.machine(id);
    if (!m) return null;
    for (const k of ['label', 'host', 'port', 'username']) if (patch[k] != null) m[k] = k === 'port' ? Number(patch[k]) : String(patch[k]);
    if (patch.password) m.password = String(patch.password);
    await this.machinesFile.save();
    return m;
  }

  async removeMachine(id) {
    const before = this.machines().length;
    this.machinesFile.data.machines = this.machines().filter((m) => m.id !== id);
    this.status.delete(id);
    if (this.machines().length === before) return false;
    await this.machinesFile.save();
    return true;
  }

  async _tick() {
    await Promise.all(this.machines().map(async (m) => {
      try {
        const xml = await fetchVmixApi(m.host, m.port, { username: m.username, password: m.password, timeoutMs: 1800 });
        this.status.set(m.id, { reachable: true, error: null, at: Date.now(), ...parseVmixState(xml) });
      } catch (e) {
        const prev = this.status.get(m.id);
        this.status.set(m.id, { ...(prev || {}), reachable: false, error: e instanceof VmixError ? e.code : e.message, at: Date.now() });
      }
    }));
    this._trackConnections();
  }

  // Mark invites "connected" when their call input goes live after the guest clicked Join.
  _trackConnections() {
    let dirty = false;
    for (const inv of this.invites()) {
      const call = this.callFor(inv);
      if (!call) continue;
      if (call.connected && inv.joiningAt && !inv.connectedAt) { inv.connectedAt = Date.now(); dirty = true; }
      if (!call.connected && inv.connectedAt && !inv.leftAt) { inv.leftAt = Date.now(); dirty = true; }
      if (call.connected && inv.leftAt && inv.connectedAt < Date.now() - 5000) { inv.leftAt = null; dirty = true; }
    }
    if (dirty) this.invitesFile.save().catch(() => {});
  }

  // Safe view for the admin UI (no vMix web passwords).
  machinesView() {
    return this.machines().map((m) => ({
      id: m.id, label: m.label, host: m.host, port: m.port, username: m.username, hasPassword: !!m.password,
      status: this.status.get(m.id) || null,
    }));
  }

  // ---- invites ----------------------------------------------------------------
  invites() { return this.invitesFile.data.invites; }
  invite(code) { return this.invites().find((i) => i.code === code) || null; }

  callFor(inv) {
    const st = this.status.get(inv.machineId);
    return st?.calls?.find((c) => c.key === inv.inputKey) || null;
  }

  async createInvite({ machineId, inputKey, guestName, show }) {
    const m = this.machine(machineId);
    const call = this.status.get(machineId)?.calls?.find((c) => c.key === inputKey);
    if (!m || !call) return null;
    const inv = {
      code: newInviteCode(),
      guestName: String(guestName || '').trim().slice(0, 60) || 'Guest',
      show: String(show || '').trim().slice(0, 80),
      machineId,
      inputKey,
      inputTitle: call.title,
      createdAt: Date.now(),
      openedAt: null, checkedAt: null, joiningAt: null, connectedAt: null, leftAt: null,
      check: null,
    };
    this.invites().unshift(inv);
    if (this.invites().length > 200) this.invites().length = 200;
    await this.invitesFile.save();
    return inv;
  }

  async removeInvite(code) {
    const before = this.invites().length;
    this.invitesFile.data.invites = this.invites().filter((i) => i.code !== code);
    if (this.invites().length === before) return false;
    await this.invitesFile.save();
    return true;
  }

  async guestEvent(code, type, details) {
    const inv = this.invite(code);
    if (!inv) return null;
    const now = Date.now();
    if (type === 'opened' && !inv.openedAt) inv.openedAt = now;
    if (type === 'check') { inv.checkedAt = now; inv.check = details ?? null; }
    if (type === 'joining') inv.joiningAt = now;
    await this.invitesFile.save();
    return inv;
  }

  invitesView() {
    return this.invites().map((i) => {
      const call = this.callFor(i);
      return { ...i, machineLabel: this.machine(i.machineId)?.label || '?', callConnected: call?.connected ?? null, callTitle: call?.title ?? i.inputTitle };
    });
  }

  // What the guest page may see.
  guestView(code) {
    const inv = this.invite(code);
    if (!inv) return null;
    const call = this.callFor(inv);
    return {
      guestName: inv.guestName,
      show: inv.show,
      ready: !!call?.password, // the call input exists and has a password
      connected: !!call?.connected,
    };
  }

  joinUrl(code, name) {
    const inv = this.invite(code);
    const call = inv && this.callFor(inv);
    if (!call?.password) return null;
    return vmixCallUrl(call.password, name || inv.guestName);
  }
}
