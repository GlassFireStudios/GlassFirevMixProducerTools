// Peplink InControl2 client.
//
// OAuth2 client-credentials against api.ic.peplink.com, then polls the org's
// devices once a minute (InControl data is per-minute at best). Keeps the last
// raw responses so the Network page can show everything IC2 returns while we
// tune the parsed view against real data.
//
// Credentials live in data/peplink.json (gitignored), written from the admin
// UI; the secret is never sent back to the browser. IC2 allows one live token
// per client, so this hub must be the only user of its client.

import { promises as fs } from 'fs';
import path from 'path';
import { atomicWrite } from './atomic.js';

const FILE = path.resolve('data', 'peplink.json');
const API = process.env.IC2_API || 'https://api.ic.peplink.com';
const POLL_MS = 60_000;
const TIMEOUT_MS = 10_000;

async function call(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

// Pull the useful bits out of an IC2 device record, tolerating field-name drift.
export function summarizeDevice(d) {
  const ifaces = Array.isArray(d.interfaces) ? d.interfaces : [];
  return {
    id: d.id ?? d.device_id ?? null,
    groupId: d.group_id ?? d.groupId ?? null,
    name: d.name ?? d.device_name ?? d.sn ?? 'device',
    sn: d.sn ?? null,
    model: d.product_name ?? d.model ?? d.product_code ?? null,
    firmware: d.fw_ver ?? d.firmware_version ?? null,
    online: d.onlineStatus != null ? String(d.onlineStatus).toUpperCase() === 'ONLINE' : String(d.status ?? '').toLowerCase() === 'online',
    lastOnline: d.last_online ?? d.lastOnline ?? null,
    location: d.latitude != null ? { lat: d.latitude, lon: d.longitude } : null,
    clients: d.client_count ?? null,
    uptimeSec: d.uptime ?? null,
    address: d.address ?? null,
    expired: !!(d.expired || d.sub_expired),
    subExpiry: d.sub_expiry_date ?? null,
    tunnels: d.pepvpn_peers ?? null,
    wans: ifaces.filter((i) => i.type !== 'lan').map((i) => {
      const sig = i.cellular_signals || i.cellular || {};
      return {
        id: i.id ?? null,
        name: i.name ?? i.type ?? 'WAN',
        type: i.type ?? i.virtualType ?? null,
        status: i.status ?? i.message ?? null,
        ip: i.ip ?? null,
        carrier: i.carrier_name ?? sig.carrier ?? null,
        band: i.gobi_band_class_name ?? null,
        rssi: sig.rssi ?? null,
        sinr: sig.sinr ?? null,
        rsrp: sig.rsrp ?? null,
        rsrq: sig.rsrq ?? null,
        bars: i.signal_bar ?? null,
        led: i.status_led ?? null,
        updatedAt: i.updated_at ?? null,
      };
    }),
  };
}

// Remaining data from a device detail record:
//  - sfconnect_data_plan: SpeedFusion Connect eSIM plan (quota/used/left in KB, per ICCID)
//  - interfaces[].speedfusion_connect_5gLte.remainingQuotaKb: what's left per SIM/WAN
//  - interfaces[].bandwidth_allowance* style fields, if an allowance is set on the WAN
// plus this month's usage from /bandwidth?type=monthly (IC2 reports MB).
export function summarizeData(detail, month) {
  const out = { plan: null, wanQuota: {}, monthUsage: null };
  const p = detail?.sfconnect_data_plan;
  if (p && (p.usage_quota_kb != null || p.quota_left_kb != null)) {
    out.plan = {
      name: p.name ?? 'SpeedFusion Connect',
      expiry: p.expiry_date ?? null,
      quotaKb: p.usage_quota_kb ?? null,
      usedKb: p.usage_consumed_kb ?? null,
      leftKb: p.quota_left_kb ?? null,
    };
  }
  for (const i of detail?.interfaces || []) {
    if (i?.id == null) continue;
    const sfc = i.speedfusion_connect_5gLte;
    const allowKey = Object.keys(i).find((k) => /allowance/i.test(k));
    const allow = allowKey ? i[allowKey] : null;
    if (sfc?.remainingQuotaKb != null) out.wanQuota[i.id] = { leftKb: sfc.remainingQuotaKb, quotaSource: 'eSIM' };
    else if (allow && typeof allow === 'object') {
      out.wanQuota[i.id] = {
        allowance: allow,
        leftKb: allow.remaining_kb ?? allow.remainingKb ?? null,
        quotaSource: 'allowance',
      };
    }
  }
  const usages = month?.usages || month?.data?.usages || [];
  const cur = usages[usages.length - 1];
  if (cur && new Date(cur.to_date) >= new Date()) out.monthUsage = { upMb: cur.up, downMb: cur.down, from: cur.from_date };
  return out;
}

// SpeedFusion peers from IC2's pepvpn/status into readable rows.
export function summarizeTunnels(pep) {
  return (pep?.peer_detail_list || []).map((t) => ({
    profile: t.profilename ?? null,
    tunnel: t.subtunnel_name ?? null,
    status: t.status ?? null,
    local: t.name ?? null,
    remote: t.remote_name ?? t.remote_site_id ?? null,
    remoteOnline: String(t.remote_device_status ?? '').toUpperCase() === 'ONLINE',
    type: t.type ?? null,
    secure: !!t.secure,
  }));
}

export class Peplink {
  constructor() {
    this.cfg = { clientId: '', clientSecret: '', orgId: '' };
    this.token = null;
    this.tokenExp = 0;
    this.devices = [];
    this.raw = {};
    this.error = null;
    this.updatedAt = null;
    this._timer = null;
    this._detail = new Map(); // deviceId -> { at, detail, month }
  }

  async load() {
    try { this.cfg = { ...this.cfg, ...JSON.parse(await fs.readFile(FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }

  get configured() { return !!(this.cfg.clientId && this.cfg.clientSecret && this.cfg.orgId); }

  publicConfig() {
    return { clientId: this.cfg.clientId, orgId: this.cfg.orgId, secretSet: !!this.cfg.clientSecret, configured: this.configured };
  }

  async setConfig({ clientId, clientSecret, orgId }) {
    if (clientId != null) this.cfg.clientId = String(clientId).trim();
    if (clientSecret) this.cfg.clientSecret = String(clientSecret).trim();
    if (orgId != null) this.cfg.orgId = String(orgId).trim();
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await atomicWrite(FILE, JSON.stringify(this.cfg, null, 2));
    await fs.chmod(FILE, 0o600).catch(() => {});
    this.token = null;
    this.tick();
  }

  start() { this.tick(); this._timer = setInterval(() => this.tick(), POLL_MS); }
  stop() { clearInterval(this._timer); }

  async _auth() {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    const form = new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: 'client_credentials' });
    const r = await call(`${API}/api/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (r.body?.error === 'invalid_client') {
      throw new Error('InControl rejected the Client ID / Secret. Use the API client\'s ID and secret from Client Applications, not your InControl login.');
    }
    if (r.status !== 200 || !r.body?.access_token) throw new Error(`InControl login failed (HTTP ${r.status})`);
    this.token = r.body.access_token;
    this.tokenExp = Date.now() + (Number(r.body.expires_in) || 3600) * 1000;
    return this.token;
  }

  async get(p) {
    const token = await this._auth();
    const r = await call(`${API}${p}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) { this.token = null; throw new Error('InControl rejected the token'); }
    if (r.status !== 200) throw new Error(`InControl ${p} HTTP ${r.status}`);
    return r.body?.data ?? r.body;
  }

  async tick() {
    if (!this.configured) return;
    try {
      const org = encodeURIComponent(this.cfg.orgId);
      const devices = await this.get(`/rest/o/${org}/d?has_status=true`);
      this.raw.devices = devices;
      this.devices = (Array.isArray(devices) ? devices : []).map(summarizeDevice);
      // SpeedFusion status per online device (best effort; endpoints vary by group).
      for (const d of this.devices) {
        if (!d.online || d.groupId == null || d.id == null) continue;
        try {
          d.pepvpn = await this.get(`/rest/o/${org}/g/${d.groupId}/d/${d.id}/pepvpn/status`);
          d.tunnelList = summarizeTunnels(d.pepvpn);
          // Per-WAN tunnel latency/loss: only meaningful while a peer is up.
          if (d.tunnelList.some((t) => t.remoteOnline)) {
            try { d.tunnelStat = await this.get(`/rest/o/${org}/g/${d.groupId}/d/${d.id}/pepvpn/tunnel_stat`); } catch (e) { d.tunnelStatError = e.message; }
          }
        } catch (e) { d.pepvpnError = e.message; }
      }
      // Data plans + monthly usage come from the per-device detail; refresh every 5 min
      // (IC2 keeps the last report for offline units, so this works for them too).
      const now = Date.now();
      for (const d of this.devices) {
        if (d.groupId == null || d.id == null) continue;
        const cached = this._detail.get(d.id);
        if (!cached || now - cached.at > 5 * 60_000) {
          try {
            const detail = await this.get(`/rest/o/${org}/g/${d.groupId}/d/${d.id}`);
            let month = null;
            try { month = await this.get(`/rest/o/${org}/g/${d.groupId}/d/${d.id}/bandwidth?type=monthly`); } catch { /* optional */ }
            this._detail.set(d.id, { at: now, detail, month });
          } catch (e) { d.detailError = e.message; }
        }
        const c = this._detail.get(d.id);
        if (c) Object.assign(d, summarizeData(c.detail, c.month));
        for (const w of d.wans) {
          const q = d.wanQuota?.[w.id];
          if (q) Object.assign(w, q);
        }
      }
      this.error = null;
      this.updatedAt = Date.now();
    } catch (e) {
      this.error = e.message;
    }
  }

  view() {
    return { config: this.publicConfig(), devices: this.devices, error: this.error, updatedAt: this.updatedAt };
  }
}
