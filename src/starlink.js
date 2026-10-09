// Starlink account API (V2, service-account client credentials).
//
// Read-only use: account, service lines + plan names, current billing-cycle
// data usage (priority/standard GB, plan limit, overage, data blocks), dishes,
// and latest dish telemetry. Usage refreshes every 5 min, telemetry every 30s
// (Starlink allows 250 requests/min per account). Tokens last ~15 min.
//
// Credentials: data/starlink.json (owner-only). The secret never leaves the hub.

import { promises as fs } from 'fs';
import path from 'path';
import { atomicWrite } from './atomic.js';

const FILE = path.resolve('data', 'starlink.json');
const BASE = process.env.STARLINK_API || 'https://starlink.com/api';
const TIMEOUT_MS = 15_000;

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

// Starlink product codes → readable names, e.g.
// "us-premium-business-local-priority-50gb-data-block" → "Local Priority 50GB data block".
export function humanizeProduct(id) {
  if (!id) return null;
  let t = String(id).replace(/^[a-z]{2}-/, '').replace(/^(premium|standard)-/, '').replace(/^business-/, '')
    .replace(/-terminal-access-fee$/, '').replace(/-data-block$/, ' data block');
  t = t.replace(/-/g, ' ').replace(/(d+)s?(gb|tb)/gi, (_, n, u) => `${n}${u.toUpperCase()}`);
  return t.replace(/([a-z])/g, (m) => m.toUpperCase()).replace(/ Data Block$/, ' data block');
}

const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

// One data-usage result → what the dashboard shows. Remaining isn't a field in
// the API; it's the plan limit minus what's been used this cycle.
export function summarizeUsage(r, productNames = {}) {
  const cycles = r?.billingCycles || [];
  const cur = cycles[cycles.length - 1] || null;
  const plan = r?.servicePlan || {};
  const priority = cur?.totalPriorityGB ?? null;
  const standard = cur?.totalStandardGB ?? null;
  const limit = plan.usageLimitGB ?? null;
  const used = plan.overageLine?.consumedAmountGB ?? priority;
  const blocks = (plan.dataPoolUsage?.dataBlocks || cur?.dataPoolUsage || []).map((b) => ({
    name: b.name ?? b.dataBlockName ?? humanizeProduct(b.productId) ?? 'Data block',
    expires: b.expirationDateUtc ?? null,
    totalGB: b.totalAmountGB ?? null,
    usedGB: b.consumedAmountGB ?? null,
    leftGB: b.totalAmountGB != null && b.consumedAmountGB != null ? round(b.totalAmountGB - b.consumedAmountGB) : null,
  }));
  return {
    serviceLine: r?.serviceLineNumber ?? null,
    plan: productNames[plan.productId] || humanizeProduct(plan.productId) || null,
    cycleStart: cur?.startDate ?? null,
    cycleEnd: cur?.endDate ?? null,
    priorityGB: round(priority),
    standardGB: round(standard),
    limitGB: limit,
    usedGB: round(used),
    leftGB: limit != null && used != null ? round(Math.max(0, limit - used)) : null,
    overageOptIn: !!plan.isOptedIntoOverage,
    overageGB: round(plan.overageLine?.overageAmountGB ?? null),
    blocks,
    daily: (cur?.dailyDataUsage || []).map((d) => ({ date: d.date, priorityGB: d.priorityGB, standardGB: d.standardGB })),
    lastUpdated: r?.lastUpdated ?? null,
  };
}

export class Starlink {
  constructor() {
    this.cfg = { clientId: '', clientSecret: '' };
    this.token = null;
    this.tokenExp = 0;
    this.account = null;
    this.lines = [];
    this.usage = [];
    this.terminals = [];
    this.telemetry = [];
    this.raw = {};
    this.error = null;
    this.usageAt = 0;
    this.telemetryAt = 0;
    this._timers = [];
  }

  async load() {
    try { this.cfg = { ...this.cfg, ...JSON.parse(await fs.readFile(FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }

  get configured() { return !!(this.cfg.clientId && this.cfg.clientSecret); }
  publicConfig() { return { clientId: this.cfg.clientId, secretSet: !!this.cfg.clientSecret, configured: this.configured }; }

  async setConfig({ clientId, clientSecret }) {
    if (clientId != null) this.cfg.clientId = String(clientId).trim();
    if (clientSecret) this.cfg.clientSecret = String(clientSecret).trim();
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await atomicWrite(FILE, JSON.stringify(this.cfg, null, 2));
    await fs.chmod(FILE, 0o600).catch(() => {});
    this.token = null;
    this.usageAt = 0;
    await this.pollUsage();
    await this.pollTelemetry();
  }

  start() {
    this.pollUsage().then(() => this.pollTelemetry());
    this._timers.push(setInterval(() => this.pollUsage(), 5 * 60_000));
    this._timers.push(setInterval(() => this.pollTelemetry(), 30_000));
  }

  stop() { this._timers.forEach(clearInterval); }

  async _auth() {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    const form = new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: 'client_credentials' });
    const r = await call(`${BASE}/auth/connect/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (r.status !== 200 || !r.body?.access_token) {
      throw new Error(r.body?.error === 'invalid_client'
        ? 'Starlink rejected the Client ID / Secret (use the service account from Starlink Settings, not your login).'
        : `Starlink login failed (HTTP ${r.status})`);
    }
    this.token = r.body.access_token;
    this.tokenExp = Date.now() + (Number(r.body.expires_in) || 900) * 1000;
    return this.token;
  }

  async api(method, p, body) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this._auth();
      const r = await call(`${BASE}${p}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 401 && attempt === 0) { this.token = null; continue; }
      if (r.status === 403) throw new Error(`Starlink: no permission for ${p} (check the service account's Read permissions)`);
      if (r.status !== 200) throw new Error(`Starlink ${p} HTTP ${r.status}`);
      return r.body?.content ?? r.body;
    }
    throw new Error('Starlink auth failed');
  }

  async _all(p) {
    const out = [];
    for (let page = 0; page < 20; page += 1) {
      const sep = p.includes('?') ? '&' : '?';
      const c = await this.api('GET', `${p}${sep}page=${page}`);
      out.push(...(c?.results || []));
      if (!c || c.isLastPage !== false) break;
    }
    return out;
  }

  async pollUsage() {
    if (!this.configured) return;
    try {
      this.account = await this.api('GET', '/public/v2/account');
      this.lines = await this._all('/public/v2/service-lines');
      const products = await this._all('/public/v2/products').catch(() => []);
      const names = Object.fromEntries(products.map((p) => [p.productReferenceId, p.name]));
      for (const l of this.lines) l.planName = names[l.productReferenceId] || humanizeProduct(l.productReferenceId);
      const usage = await this.api('POST', '/public/v2/data-usage/query?page=0&limit=100',
        { serviceLineNumbers: [], previousBillingCycles: 0, activeServiceLinesOnly: true });
      this.raw.usage = usage;
      const nick = Object.fromEntries(this.lines.map((l) => [l.serviceLineNumber, l.nickname]));
      const linePlan = Object.fromEntries(this.lines.map((l) => [l.serviceLineNumber, l.planName]));
      this.usage = (usage?.results || []).map((r) => {
        const u = summarizeUsage(r, names);
        return { ...u, plan: linePlan[r.serviceLineNumber] || u.plan, nickname: nick[r.serviceLineNumber] || null };
      });
      this.terminals = await this._all('/public/v2/user-terminals').catch(() => []);
      this.error = null;
      this.usageAt = Date.now();
    } catch (e) {
      this.error = e.message;
    }
  }

  async pollTelemetry() {
    if (!this.configured) return;
    try {
      const t = await this.api('POST', '/public/v2/telemetry/query', { includeUserTerminals: true, userTerminalIds: [] });
      this.raw.telemetry = t;
      // userTerminals comes back keyed by terminal ID (an object), not an array.
      const ut = Array.isArray(t) ? t : (t?.userTerminals ?? t?.results ?? []);
      const list = Array.isArray(ut) ? ut : Object.values(ut || {});
      this.telemetry = list.map((x) => ({
        id: x.userTerminalId ?? x.deviceId ?? null,
        downMbps: round(x.downlinkThroughputMbps),
        upMbps: round(x.uplinkThroughputMbps),
        latencyMs: round(x.popPingLatencyMsAvg),
        dropPct: x.popPingDropRateAvg != null ? round(x.popPingDropRateAvg * 100, 2) : null,
        obstructionPct: x.obstructionPercentTime != null ? round(x.obstructionPercentTime * (x.obstructionPercentTime <= 1 ? 100 : 1), 2) : null,
        signal: x.signalQuality != null ? round(x.signalQuality * 100, 0) : null,
        uptimeSec: x.uptimeSeconds ?? null,
        at: x.timestamp ?? null,
        software: x.softwareVersion ?? null,
        alerts: Object.entries(x).filter(([k, v]) => /^alert/i.test(k) && v === true).map(([k]) => k.replace(/^alert/, '')),
      }));
      this.telemetryAt = Date.now();
    } catch (e) {
      this.telemetryError = e.message;
    }
  }

  view() {
    const termByLine = {};
    for (const t of this.terminals) (termByLine[t.serviceLineNumber] ||= []).push(t);
    const tele = Object.fromEntries(this.telemetry.map((t) => [t.id, t]));
    return {
      config: this.publicConfig(),
      error: this.error,
      telemetryError: this.telemetryError || null,
      account: this.account ? { number: this.account.accountNumber, name: this.account.accountName } : null,
      usageAt: this.usageAt || null,
      telemetryAt: this.telemetryAt || null,
      lines: this.usage.map((u) => ({
        ...u,
        dishes: (termByLine[u.serviceLine] || []).map((t) => ({
          id: t.userTerminalId, nickname: t.nickname, serial: t.dishSerialNumber || t.kitSerialNumber, telemetry: tele[t.userTerminalId] || null,
        })),
      })),
    };
  }
}
