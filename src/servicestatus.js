// Outage checker.
//
// Two kinds of check, refreshed every minute:
//   - feed:      the provider's own public status page (Atlassian Statuspage
//                JSON, or RSS/JSON where that's what they publish).
//   - synthetic: our own reachability probe from AWS (TCP connect / TLS / HTTPS)
//                for services with no public feed, or to back a feed up.
// A service's overall state is the worst of its checks. Synthetic probes only
// go "down" after two consecutive failures so one blip doesn't flash red.

import net from 'net';
import tls from 'tls';

const INTERVAL_MS = 60_000;
const TIMEOUT_MS = 6_000;

const statuspage = (base, focus) => ({ kind: 'statuspage', url: `${base}/api/v2/summary.json`, page: base, focus });

export const SERVICES = [
  { id: 'vmixcall', name: 'vMix Call', checks: [
    statuspage('https://status.vmix.com'),
    { kind: 'https', url: 'https://www.vmixcall.com/', label: 'vmixcall.com' },
    { kind: 'tcp', host: 'www.vmixcall.com', port: 443, label: 'web 443' },
  ] },
  { id: 'youtube', name: 'YouTube Live', checks: [
    { kind: 'tcp', host: 'a.rtmp.youtube.com', port: 1935, label: 'RTMP ingest' },
    { kind: 'tls', host: 'a.rtmps.youtube.com', port: 443, label: 'RTMPS ingest' },
    { kind: 'https', url: 'https://www.youtube.com/', label: 'youtube.com' },
  ] },
  { id: 'facebook', name: 'Facebook Live', checks: [
    { kind: 'tls', host: 'live-api-s.facebook.com', port: 443, label: 'RTMPS ingest' },
  ] },
  { id: 'vimeo', name: 'Vimeo', checks: [statuspage('https://www.vimeostatus.com')] },
  { id: 'zoom', name: 'Zoom', checks: [statuspage('https://www.zoomstatus.com')] },
  { id: 'teams', name: 'Microsoft Teams', checks: [
    { kind: 'https', url: 'https://teams.microsoft.com/', label: 'teams.microsoft.com' },
  ] },
  { id: 'riverside', name: 'Riverside', checks: [statuspage('https://status.riverside.fm')] },
  { id: 'twitch', name: 'Twitch', checks: [statuspage('https://status.twitch.com')] },
  { id: 'cloudflare', name: 'Cloudflare', checks: [
    // Only what Live Tools depends on; Cloudflare always has some far-away PoP degraded.
    statuspage('https://www.cloudflarestatus.com', /tunnel|access|zero trust|\bdns\b|ashburn|\(iad\)/i),
  ] },
  { id: 'aws', name: 'AWS us-east-1', checks: [{ kind: 'aws', url: 'https://health.aws.amazon.com/public/currentevents' }] },
  { id: 'peplink', name: 'Peplink InControl', checks: [{ kind: 'rss', url: 'https://status.peplink.com/feed.rss', page: 'https://status.peplink.com' }] },
];

const RANK = { ok: 0, unknown: 1, minor: 2, major: 3, down: 4 };
export const worst = (states) => states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');

// Statuspage summary.json → { state, detail, incidents }
const COMPONENT_STATE = { degraded_performance: 'minor', partial_outage: 'major', major_outage: 'down', under_maintenance: 'minor' };

export function fromStatuspage(j, focus) {
  if (focus) {
    const hit = (j?.components || []).filter((c) => focus.test(c.name) && c.status && c.status !== 'operational');
    return {
      state: worst(hit.map((c) => COMPONENT_STATE[c.status] || 'minor')),
      detail: hit.length ? `${hit.length} relevant component(s) affected` : 'Services we use: operational',
      broken: hit.map((c) => `${c.name}: ${c.status.replace(/_/g, ' ')}`),
      incidents: (j?.incidents || []).filter((i) => i.status !== 'resolved' && focus.test(`${i.name} ${(i.components || []).map((c) => c.name).join(' ')}`))
        .map((i) => ({ name: i.name, status: i.status, impact: i.impact, updated: i.updated_at, url: i.shortlink })),
      maintenance: [],
    };
  }
  const ind = j?.status?.indicator;
  const state = ind === 'none' ? 'ok' : ind === 'minor' ? 'minor' : ind === 'major' ? 'major' : ind === 'critical' ? 'down' : 'unknown';
  const broken = (j?.components || []).filter((c) => c.status && c.status !== 'operational' && !c.group)
    .map((c) => `${c.name}: ${c.status.replace(/_/g, ' ')}`);
  const incidents = (j?.incidents || []).filter((i) => i.status !== 'resolved' && i.status !== 'postmortem')
    .map((i) => ({ name: i.name, status: i.status, impact: i.impact, updated: i.updated_at, url: i.shortlink }));
  const maint = (j?.scheduled_maintenances || []).filter((m) => m.status === 'in_progress').map((m) => m.name);
  return { state, detail: j?.status?.description || '', broken, incidents, maintenance: maint };
}

// AWS public current events: only flag us-east-1 / global items.
export function fromAws(list) {
  const hits = (Array.isArray(list) ? list : []).filter((e) => {
    const r = String(e.region_name || e.region || '').toLowerCase();
    return !r || r.includes('us-east-1') || r.includes('n. virginia') || r === 'global';
  });
  return {
    state: hits.length ? 'minor' : 'ok',
    detail: hits.length ? `${hits.length} active AWS event(s)` : 'No active events',
    incidents: hits.slice(0, 5).map((e) => ({ name: e.summary || e.service_name || 'AWS event', status: e.status || 'open' })),
    broken: [],
  };
}

// RSS: flag items published in the last 12h as a notice.
export function fromRss(xml, now = Date.now()) {
  const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const t = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(m[1])?.[1]?.trim();
    const d = Date.parse(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1])?.[1] || '');
    return { name: t || 'Update', date: d };
  });
  const recent = items.filter((i) => Number.isFinite(i.date) && now - i.date < 12 * 3600 * 1000);
  const open = recent.filter((i) => !/resolved|completed/i.test(i.name));
  return {
    state: open.length ? 'minor' : 'ok',
    detail: open.length ? open[0].name : (items[0] ? `Last update: ${items[0].name}` : 'No updates'),
    incidents: open.map((i) => ({ name: i.name, status: 'reported' })),
    broken: [],
  };
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'GlassFire-LiveTools-StatusCheck/1.0' } });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, ms: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

function probeTcp(host, port, useTls) {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (ok, err) => { sock.destroy(); resolve({ ok, ms: Date.now() - started, err }); };
    const sock = useTls
      ? tls.connect({ host, port, servername: host, timeout: TIMEOUT_MS }, () => done(true))
      : net.connect({ host, port, timeout: TIMEOUT_MS }, () => done(true));
    sock.on('timeout', () => done(false, 'timeout'));
    sock.on('error', (e) => done(false, e.code || e.message));
  });
}

async function runCheck(c) {
  try {
    if (c.kind === 'statuspage') {
      const r = await fetchText(c.url);
      if (r.status !== 200) return { state: 'unknown', detail: `status page HTTP ${r.status}` };
      return { ...fromStatuspage(JSON.parse(r.buf.toString('utf8')), c.focus), source: 'feed', page: c.page };
    }
    if (c.kind === 'aws') {
      const r = await fetchText(c.url);
      // AWS serves this as UTF-16 with a BOM (seen big-endian); handle either.
      let text;
      if (r.buf[0] === 0xff && r.buf[1] === 0xfe) text = r.buf.subarray(2).toString('utf16le');
      else if (r.buf[0] === 0xfe && r.buf[1] === 0xff) text = Buffer.from(r.buf.subarray(2)).swap16().toString('utf16le');
      else text = r.buf.toString('utf8');
      return { ...fromAws(JSON.parse(text.trim() || '[]')), source: 'feed', page: 'https://health.aws.amazon.com/health/status' };
    }
    if (c.kind === 'rss') {
      const r = await fetchText(c.url);
      return { ...fromRss(r.buf.toString('utf8')), source: 'feed', page: c.page };
    }
    if (c.kind === 'https') {
      const r = await fetchText(c.url);
      const ok = r.status < 500;
      return { state: ok ? 'ok' : 'down', detail: `${c.label}: HTTP ${r.status} in ${r.ms} ms`, ms: r.ms, source: 'probe' };
    }
    if (c.kind === 'tcp' || c.kind === 'tls') {
      const r = await probeTcp(c.host, c.port, c.kind === 'tls');
      return { state: r.ok ? 'ok' : 'down', detail: `${c.label}: ${r.ok ? `reachable in ${r.ms} ms` : r.err}`, ms: r.ms, source: 'probe' };
    }
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    return { state: c.kind === 'statuspage' || c.kind === 'aws' || c.kind === 'rss' ? 'unknown' : 'down', detail: `${c.label || c.url}: ${msg}`, source: c.kind === 'https' ? 'probe' : 'feed' };
  }
  return { state: 'unknown', detail: 'unsupported check' };
}

export class ServiceStatus {
  constructor(services = SERVICES) {
    this.services = services;
    this.state = new Map(); // id -> {state, checks, since, history}
    this._fails = new Map();
    this._timer = null;
  }

  start() {
    this._tick();
    this._timer = setInterval(() => this._tick(), INTERVAL_MS);
  }

  stop() { clearInterval(this._timer); }

  async _tick() {
    await Promise.all(this.services.map(async (svc) => {
      const results = await Promise.all(svc.checks.map(runCheck));
      // Debounce probes: a probe must fail twice in a row to count as down.
      results.forEach((r, i) => {
        const k = `${svc.id}:${i}`;
        if (r.source === 'probe' && r.state === 'down') {
          const n = (this._fails.get(k) || 0) + 1;
          this._fails.set(k, n);
          if (n < 2) r.state = 'minor';
        } else this._fails.set(k, 0);
      });
      const overall = worst(results.map((r) => r.state));
      const prev = this.state.get(svc.id);
      const history = prev?.history || [];
      if (!prev || prev.state !== overall) history.push({ t: Date.now(), state: overall });
      if (history.length > 50) history.shift();
      this.state.set(svc.id, {
        id: svc.id,
        name: svc.name,
        state: overall,
        since: !prev || prev.state !== overall ? Date.now() : prev.since,
        checkedAt: Date.now(),
        checks: results,
        history,
      });
    }));
  }

  snapshot() {
    return this.services.map((s) => this.state.get(s.id) || { id: s.id, name: s.name, state: 'unknown', checks: [] });
  }
}
