// FusionHub live stats (Peplink router API, firmware 8.x) over the VPC.
//
// Setup is one-time: the admin types the FusionHub admin login into the
// dashboard, the hub logs in, creates a read-only API client for itself
// (scope api.read-only) and throws the admin password away. From then on it
// uses short-lived access tokens from that client.
//
// Every 2s it reads SpeedFusion (PepVPN) peer/tunnel status. Tunnel counters
// are cumulative, so throughput and loss are computed from deltas. History is
// ~1h per series in memory.

import { promises as fs } from 'fs';
import path from 'path';
import { Agent, fetch } from 'undici';
import { atomicWrite } from './atomic.js';

const FILE = path.resolve('data', 'fusionhub.json');
const POLL_MS = 2000;
const HISTORY = 1800; // 1h at 2s
// FusionHub uses a self-signed certificate; we only ever talk to it over the
// private VPC address, so accept it for this host alone.
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

async function req(base, p, { method = 'GET', body, cookie } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${base}${p}`, {
      method,
      dispatcher: insecure,
      signal: ctrl.signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { json, setCookie: res.headers.getSetCookie?.() || [] };
  } finally {
    clearTimeout(t);
  }
}

// Walk a PepVPN status response and pull out per-peer, per-WAN numbers,
// tolerating the shape differences between firmware builds.
export function extractTunnels(resp) {
  const peers = [];
  const peerMap = resp?.peer || {};
  const order = Array.isArray(peerMap.order) ? peerMap.order : Object.keys(peerMap).filter((k) => k !== 'order');
  for (const id of order) {
    const p = peerMap[id];
    if (!p || typeof p !== 'object') continue;
    const tunnel = resp?.tunnel?.[id] || p.tunnel || {};
    const wans = [];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object' && ('rtt' in v || 'rx' in v || 'tx' in v || 'latency' in v)) {
          wans.push({
            key: `${k}`,
            name: v.name || v.wanName || `WAN ${k}`,
            state: v.state || v.status || null,
            rttMs: num(v.rtt ?? v.latency),
            rxBytes: num(v.rx?.bytes ?? v.rxBytes ?? v.rx),
            txBytes: num(v.tx?.bytes ?? v.txBytes ?? v.tx),
            rxLoss: num(v.rx?.loss ?? v.rxLoss ?? v.loss),
            txLoss: num(v.tx?.loss ?? v.txLoss),
            rxPackets: num(v.rx?.packets ?? v.rxPackets),
            fec: num(v.rx?.fec ?? v.fec),
            recovered: num(v.rx?.recover ?? v.recover),
          });
        } else if (v && typeof v === 'object') walk(v);
      }
    };
    walk(tunnel);
    peers.push({ id: String(id), name: p.name || p.remoteName || p.profileName || `Peer ${id}`, state: p.state || p.status || null, wans });
  }
  return peers;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export function rateFrom(prev, cur, dtMs) {
  if (prev == null || cur == null || dtMs <= 0 || cur < prev) return null;
  return ((cur - prev) * 8) / (dtMs / 1000) / 1e6; // Mbps
}

export class FusionHub {
  constructor() {
    this.cfg = { host: process.env.FUSIONHUB_HOST || '172.31.73.237', clientId: '', clientSecret: '' };
    this.token = null;
    this.tokenExp = 0;
    this.peers = [];
    this.history = new Map(); // `${peer}|${wan}` -> [{t, rttMs, rxMbps, txMbps, lossPerSec}]
    this.prev = new Map();
    this.raw = null;
    this.error = null;
    this.at = null;
    this._timer = null;
    this._busy = false;
  }

  base() { return `https://${this.cfg.host}`; }
  get configured() { return !!(this.cfg.clientId && this.cfg.clientSecret); }
  publicConfig() { return { host: this.cfg.host, clientId: this.cfg.clientId, configured: this.configured }; }

  async load() {
    try { this.cfg = { ...this.cfg, ...JSON.parse(await fs.readFile(FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }

  async _save() {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await atomicWrite(FILE, JSON.stringify(this.cfg, null, 2));
    await fs.chmod(FILE, 0o600).catch(() => {});
  }

  // One-time: admin login → create read-only API client → log out. The admin
  // password is only held in this function's arguments.
  async connect({ host, username, password }) {
    if (host) this.cfg.host = String(host).trim();
    const login = await req(this.base(), '/api/login', { method: 'POST', body: { username, password } });
    if (login.json.stat !== 'ok') throw new Error(`FusionHub login failed (${login.json.message || login.json.code || 'unknown'})`);
    const cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');
    const made = await req(this.base(), '/api/auth.client', {
      method: 'POST', cookie, body: { action: 'add', name: 'GlassFire Live Tools', scope: 'api.read-only' },
    });
    await req(this.base(), '/api/logout', { method: 'POST', cookie }).catch(() => {});
    const r = made.json.response || {};
    if (made.json.stat !== 'ok' || !r.clientId || !r.clientSecret) {
      throw new Error(`Could not create the API client (${made.json.message || made.json.code || 'unknown'})`);
    }
    this.cfg.clientId = r.clientId;
    this.cfg.clientSecret = r.clientSecret;
    await this._save();
    this.token = null;
    await this.tick();
  }

  async _auth() {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    const g = await req(this.base(), '/api/auth.token.grant', {
      method: 'POST', body: { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret, scope: 'api.read-only' },
    });
    if (g.json.stat !== 'ok' || !g.json.response?.accessToken) throw new Error(`FusionHub token failed (${g.json.message || g.json.code})`);
    this.token = g.json.response.accessToken;
    this.tokenExp = Date.now() + (Number(g.json.response.expiresIn) || 3600) * 1000;
    return this.token;
  }

  async get(p) {
    const token = await this._auth();
    const sep = p.includes('?') ? '&' : '?';
    const r = await req(this.base(), `${p}${sep}accessToken=${encodeURIComponent(token)}`);
    if (r.json.stat !== 'ok') {
      if (r.json.code === 401) this.token = null;
      throw new Error(`FusionHub ${p.split('?')[0]}: ${r.json.message || r.json.code}`);
    }
    return r.json.response;
  }

  start() { this._timer = setInterval(() => this.tick(), POLL_MS); this.tick(); }
  stop() { clearInterval(this._timer); }

  async tick() {
    if (!this.configured || this._busy) return;
    this._busy = true;
    try {
      const resp = await this.get('/api/status.pepvpn?infoType=profile%20peer%20tunnel');
      this.raw = resp;
      const now = Date.now();
      this.peers = extractTunnels(resp);
      for (const p of this.peers) {
        for (const w of p.wans) {
          const k = `${p.id}|${w.key}`;
          const prev = this.prev.get(k);
          const dt = prev ? now - prev.t : 0;
          const lossNow = (w.rxLoss ?? 0) + (w.txLoss ?? 0);
          const point = {
            t: now,
            rttMs: w.rttMs,
            rxMbps: prev ? rateFrom(prev.rx, w.rxBytes, dt) : null,
            txMbps: prev ? rateFrom(prev.tx, w.txBytes, dt) : null,
            lossPerSec: prev && lossNow >= prev.loss ? (lossNow - prev.loss) / (dt / 1000) : null,
          };
          this.prev.set(k, { t: now, rx: w.rxBytes, tx: w.txBytes, loss: lossNow });
          const h = this.history.get(k) || [];
          h.push(point);
          if (h.length > HISTORY) h.shift();
          this.history.set(k, h);
          Object.assign(w, { rxMbps: point.rxMbps, txMbps: point.txMbps, lossPerSec: point.lossPerSec });
        }
      }
      this.error = null;
      this.at = now;
    } catch (e) {
      this.error = e.message;
    } finally {
      this._busy = false;
    }
  }

  view(since = 0) {
    return {
      config: this.publicConfig(),
      error: this.error,
      at: this.at,
      peers: this.peers.map((p) => ({
        ...p,
        wans: p.wans.map((w) => ({ ...w, history: (this.history.get(`${p.id}|${w.key}`) || []).filter((x) => x.t > since) })),
      })),
    };
  }
}
