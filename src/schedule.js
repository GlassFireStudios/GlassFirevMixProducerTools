// Show schedules: loop blocks (what the auto-switch puts on screen) and events
// (what the countdown counts down to), per kit. Edited on livetools /schedule,
// including running early/late (a shift in seconds on top of the planned time).
//
// Times are the venue's wall clock, written "YYYY-MM-DDTHH:mm[:ss]" with no zone;
// the show computers run on venue time. The hub turns a schedule into two small
// kit files the field agent syncs to every computer:
//   Countdown/schedule.js  read by countdown.html (re-read every 20 s)
//   vMix/schedule.txt      read by the vMix AutoSwitch script
// Persisted to data/schedules/<kit>.json.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWrite } from './atomic.js';

const DIR = path.resolve('data', 'schedules');
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const LOOKS = ['equip', 'morning', 'energize'];
const MAX_SHIFT = 24 * 3600;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const p2 = (n) => String(n).padStart(2, '0');

// Wall-clock arithmetic without time zones: treat the fields as UTC and back.
export function addSeconds(local, seconds) {
  const m = LOCAL.exec(local);
  if (!m) return local;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) + Math.round(seconds || 0) * 1000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}
export const effective = (item) => addSeconds(item.start, item.shiftSec || 0);

// "3" = 3 min, "2:30" = 2 min 30 s, "30s" = 30 s, "-1:15" = 1 min 15 s earlier.
export function parseShift(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  let m = /^([+-]?)(\d+):([0-5]?\d)$/.exec(s);
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  m = /^([+-]?)(\d+(?:\.\d+)?)(s|sec|m|min)?$/.exec(s);
  if (m) return (m[1] === '-' ? -1 : 1) * Math.round(Number(m[2]) * (m[3] && m[3].startsWith('s') ? 1 : 60));
  return null;
}

export function cleanItem(input, prev = {}) {
  const it = { ...prev };
  if (input.kind != null) it.kind = input.kind === 'block' ? 'block' : 'event';
  if (input.start != null) {
    const s = str(input.start, 19);
    if (!LOCAL.test(s)) throw new Error('Time must look like 2026-10-22T14:00');
    it.start = s.slice(0, 16);
  }
  if (input.shiftSec != null) {
    const n = Math.round(Number(input.shiftSec));
    if (!Number.isFinite(n) || Math.abs(n) > MAX_SHIFT) throw new Error('Shift must be within a day');
    it.shiftSec = n;
  }
  if (input.name != null) it.name = str(input.name, 60);
  if (input.title != null) it.title = str(input.title, 80);
  if (input.where != null) it.where = str(input.where, 80);
  if (input.look != null) it.look = LOOKS.includes(input.look) ? input.look : 'equip';
  if (input.enabled != null) it.enabled = !!input.enabled;
  if (!it.start) throw new Error('Missing time');
  if (it.kind === 'block' && !it.name) throw new Error('A block needs the loop name (for example 4 THU B)');
  if (it.kind === 'event' && !it.title) throw new Error('An event needs a title');
  return it;
}

// The two files the computers get. Sorted by actual time; disabled items left out.
export function scheduleFiles(sched) {
  const on = sched.items.filter((i) => i.enabled !== false);
  const sort = (a, b) => (effective(a) < effective(b) ? -1 : effective(a) > effective(b) ? 1 : 0);
  const events = on.filter((i) => i.kind === 'event').sort(sort)
    .map((e) => ({ id: e.id, title: e.title, where: e.where || '', start: effective(e), look: e.look || 'equip', shiftSec: e.shiftSec || 0 }));
  const blocks = on.filter((i) => i.kind === 'block').sort(sort);
  const js = `// GlassFire schedule v${sched.version} (${new Date(sched.updatedAt || 0).toISOString()})\nwindow.EQUIP_SCHEDULE = ${JSON.stringify({ v: sched.version, events })};\n`;
  const txt = blocks.map((b) => `${effective(b)}|${b.name}`).join('\r\n') + '\r\n';
  return [
    { path: 'Countdown/schedule.js', content: js },
    { path: 'vMix/schedule.txt', content: txt },
  ].map((f) => ({ ...f, sha256: sha(f.content), size: Buffer.byteLength(f.content, 'utf8') }));
}

// "2 min 30 s later" / "30 s earlier"
export function describeShift(sec) {
  const a = Math.abs(sec);
  const parts = [];
  if (a >= 60) parts.push(`${Math.floor(a / 60)} min`);
  if (a % 60) parts.push(`${a % 60} s`);
  return `${parts.join(' ') || '0 s'} ${sec >= 0 ? 'later' : 'earlier'}`;
}

export class Schedules {
  constructor({ notify } = {}) { this.map = new Map(); this.notify = notify || (() => {}); }

  async load() {
    await fs.mkdir(DIR, { recursive: true });
    for (const f of await fs.readdir(DIR)) {
      if (!f.endsWith('.json')) continue;
      try { const s = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8')); this.map.set(s.kit, s); } catch { /* skip */ }
    }
    return this;
  }

  get(kit) { return this.map.get(kit) || null; }
  list() { return [...this.map.values()]; }

  async _save(s) {
    s.version = (s.version || 0) + 1;
    s.updatedAt = Date.now();
    s.files = scheduleFiles(s);
    await atomicWrite(path.join(DIR, `${s.kit}.json`), JSON.stringify(s, null, 2));
    return s;
  }

  // First publish of a kit with a schedule seed creates its editable schedule.
  async seed(kit, seed, title) {
    if (this.get(kit) || !seed) return null;
    const id = () => crypto.randomBytes(6).toString('base64url');
    const items = [
      ...(seed.blocks || []).map((b) => cleanItem({ kind: 'block', name: b.name, start: b.start, shiftSec: 0, enabled: true }, { id: id() })),
      ...(seed.events || []).map((e) => cleanItem({ kind: 'event', title: e.title, where: e.where, start: e.start, look: e.look || 'equip', shiftSec: 0, enabled: true }, { id: id() })),
    ];
    const s = { kit, title: title || kit, items, version: 0 };
    this.map.set(kit, s);
    return this._save(s);
  }

  async add(kit, input) {
    const s = this.get(kit);
    if (!s) return null;
    const it = cleanItem({ shiftSec: 0, enabled: true, look: 'equip', ...input }, { id: crypto.randomBytes(6).toString('base64url') });
    s.items.push(it);
    await this._save(s);
    this.notify(`:calendar: *${s.title}*: added ${label(it)} at ${fmt(effective(it))}`);
    return it;
  }

  async update(kit, id, input) {
    const s = this.get(kit);
    const i = s ? s.items.findIndex((x) => x.id === id) : -1;
    if (i < 0) return null;
    const before = s.items[i];
    s.items[i] = cleanItem(input, before);
    await this._save(s);
    const after = s.items[i];
    if (effective(before) !== effective(after)) this.notify(`:clock3: *${s.title}*: ${label(after)} now ${fmt(effective(after))}${runningText(after.shiftSec)}`);
    return after;
  }

  // Run early/late by some seconds: one item, or it and everything after it that
  // same day (never the next day).
  async shift(kit, id, seconds, following = false) {
    const s = this.get(kit);
    const it = s?.items.find((x) => x.id === id);
    if (!it) return null;
    const from = effective(it);
    const day = from.slice(0, 10);
    const moved = following
      ? s.items.filter((x) => x.kind === it.kind && effective(x) >= from && effective(x).slice(0, 10) === day)
      : [it];
    for (const x of moved) x.shiftSec = (x.shiftSec || 0) + Math.round(seconds);
    await this._save(s);
    const rest = following && moved.length > 1 ? ` and ${moved.length - 1} after it` : '';
    this.notify(`:clock3: *${s.title}*: ${label(it)}${rest} moved ${describeShift(seconds)} (now ${fmt(effective(it))}${runningText(it.shiftSec)})`);
    return moved;
  }

  async remove(kit, id) {
    const s = this.get(kit);
    if (!s) return false;
    const it = s.items.find((x) => x.id === id);
    if (!it) return false;
    s.items = s.items.filter((x) => x !== it);
    await this._save(s);
    this.notify(`:wastebasket: *${s.title}*: removed ${label(it)}`);
    return true;
  }
}

const label = (it) => (it.kind === 'block' ? `loop block ${it.name}` : `"${it.title}"`);
const runningText = (sec) => (!sec ? ', on time' : `, ${describeShift(sec).replace('later', 'late').replace('earlier', 'early')}`);
function fmt(local) {
  const m = LOCAL.exec(local);
  if (!m) return local;
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return `${day} ${m[4]}:${m[5]}${m[6] && m[6] !== '00' ? `:${m[6]}` : ''}`;
}
