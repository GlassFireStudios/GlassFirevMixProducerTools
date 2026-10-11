// Screen checks: a venue screen opens live.glassfire.co/check and reports what it
// can really do (resolution, 1080p/4K decode, network speed). Kept so we can show
// a client every sign's actual capability. Persisted to data/screenchecks.json.

import { promises as fs } from 'fs';
import path from 'path';
import { atomicWrite } from './atomic.js';

const FILE = path.resolve('data', 'screenchecks.json');
const MAX = 500;

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : null;
};
const DECODES = ['h264_1080p30', 'h264_1080p60', 'h264_2160p30', 'h264_2160p60', 'hevc_2160p30'];

// The verdict the screen shows, and the dashboard repeats.
export function verdict(r) {
  const long = Math.max(r.screenW || 0, r.screenH || 0);
  const d = r.decode || {};
  const smooth = (k) => d[k] === 'smooth';
  const ok = (k) => d[k] === 'smooth' || d[k] === 'yes';
  const mbps = r.downMbps ?? 0;
  if (long >= 3800 && ok('h264_2160p30') && mbps >= 25) return { level: '4k', label: 'Can show 4K' };
  if (ok('h264_1080p30') && mbps >= 8) {
    const why = long < 3800 ? 'screen is not 4K' : !ok('h264_2160p30') ? 'player cannot decode 4K' : 'network too slow for 4K';
    return { level: '1080p', label: `1080p (${why})`, smooth60: smooth('h264_1080p60') };
  }
  const why = !ok('h264_1080p30') ? 'cannot decode 1080p video' : `network ${mbps} Mbps`;
  return { level: 'weak', label: `Weak: ${why}` };
}

// Accept only the fields we know, clipped to sane sizes (the page is public).
export function cleanReport(b) {
  const decode = {};
  for (const k of DECODES) {
    const v = b?.decode?.[k];
    decode[k] = ['smooth', 'yes', 'no', 'unknown'].includes(v) ? v : 'unknown';
  }
  const r = {
    id: str(b?.id, 40).replace(/[^\w-]/g, ''),
    name: str(b?.name, 60),
    show: str(b?.show, 60).replace(/[^\w-]/g, ''),
    screenW: num(b?.screenW, 0, 20000), screenH: num(b?.screenH, 0, 20000),
    viewW: num(b?.viewW, 0, 20000), viewH: num(b?.viewH, 0, 20000), dpr: num(b?.dpr, 0, 10),
    downMbps: num(b?.downMbps, 0, 100000), pingMs: num(b?.pingMs, 0, 100000),
    ivs: b?.ivs === true, mse: b?.mse === true,
    ua: str(b?.ua, 300),
    decode,
  };
  if (!r.id) throw new Error('missing id');
  r.verdict = verdict(r);
  return r;
}

export class ScreenChecks {
  constructor() { this.data = { checks: [] }; }

  async load() {
    try { this.data = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }

  _save() { return atomicWrite(FILE, JSON.stringify(this.data, null, 2)); }
  list() { return [...this.data.checks].sort((a, b) => b.at - a.at); }

  // One row per screen (by id): a re-run replaces that screen's last result.
  async add(report, ip) {
    const row = { ...report, ip: str(ip, 60), at: Date.now() };
    this.data.checks = [row, ...this.data.checks.filter((c) => c.id !== row.id)].slice(0, MAX);
    await this._save();
    return row;
  }

  async remove(id) {
    const before = this.data.checks.length;
    this.data.checks = this.data.checks.filter((c) => c.id !== id);
    if (this.data.checks.length !== before) await this._save();
    return this.data.checks.length !== before;
  }

  async clear() { this.data.checks = []; await this._save(); }
}
