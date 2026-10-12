// GlassFire vMix Producer Tools — hub.
//
// Serves producer views (public, optionally token-gated) and a Companion-style
// admin dashboard (password gated), polls every enabled vMix connection, and
// broadcasts live countdown state over WebSocket. Also drives the Cloudflare
// tunnel that fronts the producer views at https://liveproducers.glassfire.co.

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { ConnectionStore, publicView } from './store.js';
import { Settings, PRODUCER_PORT_DEFAULT } from './settings.js';
import { Poller } from './poller.js';
import { TunnelManager } from './tunnel.js';
import { fetchVmixApi, parseVmixXml, VmixError } from './vmix.js';
import { IngestStore, decideAuth, ingestPath, INGEST_APP } from './ingest.js';
import { MediaMtxMonitor } from './mediamtx.js';
import { StreamAnalyzer } from './analyzer.js';
import { ServiceStatus } from './servicestatus.js';
import { VmixCalls } from './vmixcalls.js';
import { Peplink } from './peplink.js';
import { Starlink } from './starlink.js';
import { FusionHub } from './fusionhub.js';
import { Shows, publicShow } from './shows.js';
import { ScreenChecks, cleanReport } from './screenchecks.js';
import { Field, manifestFor, isExpired, UPLOADS_DIR, UPLOAD_CAP_BYTES, uploadsBytes } from './field.js';
import { Schedules, effective, parseShift } from './schedule.js';
import { signGet, mediaKey } from './media.js';
import { z } from 'zod';
import {
  requireAdmin, isAdmin, issueSession, setSessionCookie, clearSessionCookie,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || PRODUCER_PORT_DEFAULT;
// MediaMTX's HTTP auth hook. Bound to loopback only, never behind the tunnel.
const AUTH_HOOK_PORT = Number(process.env.AUTH_HOOK_PORT) || 8091;
const INGEST = {
  publicHost: process.env.INGEST_PUBLIC_HOST || '',
  privateHost: process.env.INGEST_PRIVATE_HOST || '',
  readCidrs: (process.env.INGEST_READ_CIDRS || '172.31.0.0/16').split(',').map((s) => s.trim()).filter(Boolean),
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
const store = new ConnectionStore();
const settings = new Settings();
await settings.load();
await store.load();
const ingests = await new IngestStore().load();
const mediamtx = new MediaMtxMonitor();
mediamtx.start();
const analyzer = new StreamAnalyzer(mediamtx);
if (process.env.ANALYZER !== 'off') analyzer.start();
const services = new ServiceStatus();
if (process.env.STATUS_CHECKS !== 'off') services.start();
const calls = await new VmixCalls().load();
calls.start();
const peplink = await new Peplink().load();
peplink.start();
const starlink = await new Starlink().load();
starlink.start();
const fusionhub = await new FusionHub().load();
fusionhub.start();
const shows = await new Shows().load();
const screenChecks = await new ScreenChecks().load();
const field = await new Field({ notify: (text) => slackNotify(text) }).load();
const schedules = await new Schedules({ notify: (text) => slackNotify(text) }).load();

// A kit published with a schedule seed gets an editable schedule on first sight.
async function kitWithSchedule(kitId) {
  await field.refreshKits();
  const kit = field.kits.get(kitId);
  if (!kit) return null;
  if (kit.scheduleSeed && !schedules.get(kitId)) await schedules.seed(kitId, kit.scheduleSeed, kit.title);
  const sched = schedules.get(kitId);
  if (!sched) return kit;
  return {
    ...kit,
    version: `${kit.version}+s${sched.version}`,
    files: [...(kit.files || []), ...sched.files.map((f) => ({ path: f.path, role: 'all', apply: 'schedule', owned: true, sha256: f.sha256, size: f.size, generated: true }))],
  };
}
setInterval(() => field.sweep().catch(() => {}), 60_000).unref();

// Field alerts go to the #field-support Slack channel via its incoming webhook.
async function slackNotify(text) {
  const url = field?.data.slackWebhook;
  if (!url) return false;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch (e) {
    console.warn('[field] slack post failed:', e.message);
    return false;
  }
}

// Public guest hostname: serves ONLY the guest join flow, never the dashboard.
const JOIN_HOST = (process.env.JOIN_HOST || 'join.glassfire.co').toLowerCase();
const JOIN_PUBLIC_BASE = process.env.JOIN_PUBLIC_BASE || `https://${JOIN_HOST}`;

const LIVE_HOST = (process.env.LIVE_HOST || 'live.glassfire.co').toLowerCase();

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (String(req.hostname).toLowerCase() !== LIVE_HOST) return next();
  // Short edge cache + serve stale if the box is briefly unreachable.
  const cache = 'public, max-age=60, stale-while-revalidate=300, stale-if-error=86400';
  if (req.path === '/watch.js') { res.setHeader('Cache-Control', cache); return res.sendFile(path.join(PUBLIC_DIR, 'watch.js')); }
  if (/^\/(check|check\.js|api\/check\/[\w]+)$/.test(req.path)) return checkRouter(req, res, next);
  if (req.path.startsWith('/fm/')) return fieldRouter(req, res, () => res.status(404).type('text').send('Not found'));
  let m = /^\/api\/show\/([\w-]+)$/.exec(req.path);
  if (m) {
    const show = shows.get(m[1]);
    if (!show || show.enabled === false) return res.status(404).json({ error: 'not-found' });
    res.setHeader('Cache-Control', 'public, max-age=30, stale-if-error=86400');
    return res.json(publicShow(show));
  }
  m = /^\/([\w-]+)\/?$/.exec(req.path);
  // Versioned script URL (?v=<app version>) so a deploy is never masked by a
  // cached watch.js; Cloudflare stretches browser cache to hours on this zone.
  if (m && shows.get(m[1])) return sendPage(res, 'watch.html', 'public, max-age=60, stale-if-error=86400');
  res.status(404).type('text').send('Not found');
});
app.use((req, res, next) => {
  if (String(req.hostname).toLowerCase() !== JOIN_HOST) return next();
  const ok = /^\/(join\/[\w-]+|api\/join\/.*|style\.css|join\.js|brand\/[\w.-]+)$/.test(req.path);
  if (ok) return next();
  res.status(404).type('text').send('Not found');
});
// Guest upload speed test needs a raw body; everything else is JSON.
app.post('/api/join/speed/up', express.raw({ type: '*/*', limit: '4mb' }), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ bytes: req.body?.length || 0 });
});
app.use(express.json({ limit: '256kb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

const poller = new Poller(store, broadcast);
poller.start();

const tunnel = new TunnelManager(() => settings.tunnel, PORT);

// ---------------------------------------------------------------------------
// Pages: stamp local CSS/JS URLs with the app version so a deploy can never pair
// a new page with a cached old stylesheet.
// ---------------------------------------------------------------------------
const APP_VERSION = JSON.parse(await fsp.readFile(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
const pageCache = new Map();
async function sendPage(res, file, cacheControl = 'no-cache') {
  let html = pageCache.get(file);
  if (!html) {
    html = (await fsp.readFile(path.join(PUBLIC_DIR, file), 'utf8'))
      .replace(/(href|src)="(\/[\w./-]+\.(?:css|js))"/g, `$1="$2?v=${APP_VERSION}"`);
    pageCache.set(file, html);
  }
  res.setHeader('Cache-Control', cacheControl);
  res.type('html').send(html);
}

// ---------------------------------------------------------------------------
// Producer access-token gate (optional)
// ---------------------------------------------------------------------------
const isHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(String(req.headers['cf-visitor'] || ''));

// Producer views: admins always pass; anyone else needs the producer link token.
// With no token set they are admin-only (the dashboard host is public).
function producerAllowed(req) {
  const token = settings.producerToken;
  if (isAdmin(req, settings)) return true;
  if (!token) return false;
  const k = req.query.k ?? req.headers['x-producer-token'];
  return k === token;
}

function gateProducer(req, res, next) {
  if (producerAllowed(req)) return next();
  res.status(401).type('html').send(producerDeniedPage());
}

// ---------------------------------------------------------------------------
// Producer routes (public)
// ---------------------------------------------------------------------------
app.get('/', (req, res) => sendPage(res, 'home.html'));
app.get('/guests', (req, res) => sendPage(res, 'guests.html'));
app.get('/network', (req, res) => sendPage(res, 'network.html'));
app.get('/vmix', (req, res) => sendPage(res, 'vmix.html'));
app.get('/shows', (req, res) => sendPage(res, 'shows.html'));
app.get('/join/:code', (req, res) => sendPage(res, 'join.html'));

// ---- Outage checker (not sensitive; the dashboard host sits behind Access) ----
app.get('/api/status/services', (req, res) => res.json({ services: services.snapshot() }));

// ---- Guest join API (public; the invite code is the credential) -----------
// Small per-IP limiter on code lookups so codes can't be brute-forced.
const joinHits = new Map();
function joinLimiter(req, res, next) {
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  const now = Date.now();
  const rec = joinHits.get(ip) || { n: 0, reset: now + 60_000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 60_000; }
  rec.n += 1;
  joinHits.set(ip, rec);
  if (rec.n > 60) return res.status(429).json({ error: 'slow-down' });
  next();
}
const SPEED_BLOB = crypto.randomBytes(2 * 1024 * 1024);
app.get('/api/join/speed/down', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/octet-stream').send(SPEED_BLOB);
});
app.get('/api/join/ping', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ t: Date.now() }); });
const JoinEvent = z.object({ type: z.enum(['opened', 'check', 'joining']), details: z.record(z.any()).optional() });
const JoinGo = z.object({ name: z.string().trim().min(1).max(60), details: z.record(z.any()).optional() });
app.get('/api/join/:code', joinLimiter, (req, res) => {
  const v = calls.guestView(req.params.code);
  if (!v) return res.status(404).json({ error: 'not-found' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(v);
});
app.post('/api/join/:code/event', joinLimiter, async (req, res) => {
  const body = JoinEvent.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid' });
  const inv = await calls.guestEvent(req.params.code, body.data.type, body.data.details);
  if (!inv) return res.status(404).json({ error: 'not-found' });
  res.json({ ok: true });
});
app.post('/api/join/:code/go', joinLimiter, async (req, res) => {
  const body = JoinGo.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid' });
  const url = calls.joinUrl(req.params.code, body.data.name);
  if (!url) return res.status(409).json({ error: 'not-ready' });
  await calls.guestEvent(req.params.code, 'joining', body.data.details);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ url });
});
// ---- Screen check (public on live.glassfire.co/check; results on /screens) ----
const checkRouter = express.Router();
const SPEED_CHUNK = crypto.randomBytes(1024 * 1024);
checkRouter.get('/check', (req, res) => sendPage(res, 'check.html'));
checkRouter.get('/check.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(PUBLIC_DIR, 'check.js')); });
checkRouter.get('/api/check/ping', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ t: Date.now() }); });
// Incompressible bytes, streamed 1 MB at a time (up to 32 MB) for the download test.
checkRouter.get('/api/check/down', joinLimiter, (req, res) => {
  const mb = Math.min(32, Math.max(1, Number.parseInt(req.query.mb, 10) || 2));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(mb * SPEED_CHUNK.length));
  res.type('application/octet-stream');
  let sent = 0;
  const pump = () => {
    while (sent < mb) {
      sent += 1;
      if (!res.write(SPEED_CHUNK)) return res.once('drain', pump);
    }
    res.end();
  };
  pump();
});
checkRouter.post('/api/check/report', joinLimiter, express.json({ limit: '16kb' }), async (req, res) => {
  let report;
  try { report = cleanReport(req.body ?? {}); } catch { return res.status(400).json({ error: 'invalid' }); }
  const row = await screenChecks.add(report, req.headers['cf-connecting-ip'] || req.socket.remoteAddress);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, verdict: row.verdict });
});
app.use(checkRouter);
app.get('/screens', (req, res) => sendPage(res, 'screens.html'));

// ---- Field machines (public on live.glassfire.co/fm/; token-authenticated) ----
const FIELD_DIR = path.join(__dirname, '..', 'field');
const fieldScripts = new Map(); // name -> { text, sha256 }
async function fieldScript(name) {
  if (!fieldScripts.has(name)) {
    const text = await fsp.readFile(path.join(FIELD_DIR, name), 'utf8');
    fieldScripts.set(name, { text, sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex') });
  }
  return fieldScripts.get(name);
}
const bearer = (req) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
function machineAuth(req, res, next) {
  const m = field.byToken(bearer(req));
  if (!m) return res.status(401).json({ error: 'unknown machine' });
  req.machine = m;
  next();
}
function supportAuth(req, res, next) {
  const m = field.bySupportKey(String(req.headers['x-support-key'] || req.query.k || ''));
  if (!m) return res.status(401).json({ error: 'This support link is not valid. Ask GlassFire for a new one.' });
  req.machine = m;
  next();
}
const fieldRouter = express.Router();
fieldRouter.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
fieldRouter.get('/fm/install.ps1', async (req, res) => res.type('text/plain').send((await fieldScript('install.ps1')).text));
fieldRouter.get('/fm/agent.ps1', async (req, res) => res.type('text/plain').send((await fieldScript('agent.ps1')).text));
fieldRouter.post('/fm/api/enroll', joinLimiter, express.json({ limit: '8kb' }), async (req, res) => {
  const r = await field.enroll(req.body?.code, req.body?.hostname);
  if (!r) return res.status(404).json({ error: 'That install code is wrong or has expired. Make a new one on livetools > Field.' });
  slackNotify(`:computer: *${r.machine.name}* installed on ${r.machine.hostname || 'a machine'}`);
  res.json({ machineId: r.machine.id, name: r.machine.name, role: r.machine.role, kit: r.machine.kit, token: r.token, supportKey: r.supportKey, hub: `https://${LIVE_HOST}` });
});
fieldRouter.get('/fm/api/manifest', machineAuth, async (req, res) => {
  let kit = (await kitWithSchedule(req.machine.kit)) || { kit: req.machine.kit, version: '', root: 'C:\\GlassFire\\Kit', files: [], media: [] };
  // Media lives in S3: hand the machine short-lived signed download links.
  if (kit.mediaS3 && !isExpired(req.machine)) {
    const media = await Promise.all((kit.media || []).map(async (m) => ({ ...m, url: await signGet(mediaKey(kit.mediaS3, m.path)).catch(() => '') })));
    kit = { ...kit, media };
  }
  res.json({ ...manifestFor(kit, req.machine), agent: { sha256: (await fieldScript('agent.ps1')).sha256 } });
});
fieldRouter.get('/fm/api/file', machineAuth, (req, res) => {
  const m = req.machine;
  if (isExpired(m)) return res.status(404).json({ error: 'not-found' });
  const gen = schedules.get(m.kit)?.files.find((f) => f.path === req.query.path);
  if (gen) return res.type(gen.path.endsWith('.js') ? 'application/javascript' : 'text/plain').send(Buffer.from(gen.content, 'utf8'));
  const entry = field.kitEntry(m.kit, m, String(req.query.path || ''));
  if (!entry) return res.status(404).json({ error: 'not-found' });
  res.sendFile(field.kitFilePath(m.kit, entry.stored || entry.path));
});
fieldRouter.post('/fm/api/heartbeat', machineAuth, express.json({ limit: '64kb' }), async (req, res) => {
  const b = req.body || {};
  const v = b.vmix || {};
  const clip = (s, n = 200) => String(s ?? '').slice(0, n);
  await field.heartbeat(req.machine, {
    at: Date.now(), kitVersion: clip(b.kitVersion, 40), agentVersion: clip(b.agentVersion, 80), hostname: clip(b.hostname, 80),
    timezone: clip(b.timezone, 80), clockSkewSec: Number(b.clockSkewSec) || 0, diskFreeGB: Number(b.diskFreeGB) || 0, uptimeHours: Number(b.uptimeHours) || 0,
    missingMedia: (Array.isArray(b.missingMedia) ? b.missingMedia : []).slice(0, 50).map((s) => clip(s, 200)),
    notes: (Array.isArray(b.notes) ? b.notes : []).slice(0, 20).map((s) => clip(s, 300)),
    expiredApplied: !!b.expiredApplied,
    vmix: {
      running: !!v.running, version: clip(v.version, 40), edition: clip(v.edition, 40), preset: clip(v.preset, 260),
      active: clip(v.active, 120), preview: clip(v.preview, 120), streaming: !!v.streaming, recording: !!v.recording, external: !!v.external,
      overlays: (Array.isArray(v.overlays) ? v.overlays : []).slice(0, 8).map((s) => clip(s, 120)), inputs: Number(v.inputs) || 0,
    },
  });
  res.json({ ok: true, serverTime: Date.now() });
});
// Support app: the machine's support key only (it cannot read kit files).
fieldRouter.get('/fm/support', (req, res) => sendPage(res, 'support.html'));
fieldRouter.get('/fm/support.js', (req, res) => res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'support.js')));
fieldRouter.get('/fm/api/support/me', supportAuth, (req, res) => {
  const m = field.publicMachine(req.machine);
  res.json({
    machine: { name: m.name, role: m.role, online: m.online, expired: m.expired, expiresAt: m.expiresAt, status: m.status },
    tickets: field.tickets(req.machine.id).map(({ context, ...t }) => t),
  });
});
fieldRouter.post('/fm/api/support/tickets', supportAuth, joinLimiter, express.json({ limit: '32kb' }), async (req, res) => {
  try { res.json({ ticket: await field.createTicket(req.machine, req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
// Media upload in chunks (Cloudflare caps one request at 100 MB). ?ticket&name&offset&size
fieldRouter.post('/fm/api/support/upload', supportAuth, express.raw({ type: '*/*', limit: '9mb' }), async (req, res) => {
  const t = field.ticket(String(req.query.ticket || ''));
  if (!t || t.machineId !== req.machine.id) return res.status(404).json({ error: 'not-found' });
  const size = Number(req.query.size) || 0;
  const offset = Number(req.query.offset) || 0;
  const chunk = req.body || Buffer.alloc(0);
  if (offset === 0 && (await uploadsBytes()) + size > UPLOAD_CAP_BYTES) return res.status(507).json({ error: 'GlassFire upload space is full. Post in Slack and we will collect the file another way.' });
  const f = await field.addFile(t, req.query.name, size);
  const dir = path.join(UPLOADS_DIR, t.id);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, f.name);
  const have = await fsp.stat(dest).then((s) => s.size).catch(() => 0);
  if (offset !== have) return res.status(409).json({ error: 'offset', have });
  await fsp.appendFile(dest, chunk);
  const now = have + chunk.length;
  if (now >= size && !f.done) {
    f.done = true;
    await field._save();
    slackNotify(`:paperclip: *${req.machine.name}* uploaded *${f.name}* (${(size / 1048576).toFixed(1)} MB) to ticket ${t.id}`);
  }
  res.json({ ok: true, have: now });
});

app.use(fieldRouter);
app.get('/field', (req, res) => sendPage(res, 'field.html'));
app.get('/schedule', (req, res) => sendPage(res, 'schedule.html'));

app.get('/producer', gateProducer, (req, res) => sendPage(res, 'index.html'));
app.get('/grid.html', gateProducer, (req, res) => sendPage(res, 'grid.html'));
app.get('/s/:id', gateProducer, (req, res) => sendPage(res, 'stream.html'));

app.get('/api/streams', gateProducer, (req, res) => {
  res.json({ streams: store.enabled().map(publicView), states: poller.snapshot() });
});

app.get('/api/state/:id', gateProducer, (req, res) => {
  const conn = store.get(req.params.id);
  if (!conn || !conn.enabled) return res.status(404).json({ error: 'not-found' });
  res.json(poller.getState(req.params.id) ?? { id: req.params.id, reachable: false });
});

// Block direct .html access so producer views can't bypass the token gate via
// /index.html, /stream.html, etc. They must go through the gated clean routes.
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    if (req.path === '/admin.html') return res.redirect('/admin');
    return res.status(404).end();
  }
  next();
});

// Static assets (css/js). HTML is handled by explicit gated routes above.
// no-cache = always revalidate (ETag), so browsers and Cloudflare never serve a
// stale stylesheet against a newer page.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  extensions: [],
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ---------------------------------------------------------------------------
// Admin dashboard (gated)
// ---------------------------------------------------------------------------
app.get('/admin', (req, res) => sendPage(res, 'admin.html'));
app.get('/ingest/:id', (req, res) => sendPage(res, 'ingest.html'));

// The admin password is the only lock on the dashboard: slow down guessing.
// Per IP: 8 failures per 15 min, then locked until the window passes.
const loginFails = new Map();
app.post('/api/admin/login', (req, res) => {
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  const now = Date.now();
  const rec = loginFails.get(ip) || { n: 0, reset: now + 15 * 60_000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 15 * 60_000; }
  if (rec.n >= 8) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  const { password } = req.body ?? {};
  if (!settings.verifyAdmin(password)) {
    rec.n += 1;
    loginFails.set(ip, rec);
    console.warn(`[admin] failed login from ${ip} (${rec.n})`);
    return res.status(401).json({ error: 'bad-password' });
  }
  loginFails.delete(ip);
  setSessionCookie(res, issueSession(settings.sessionSecret), isHttps(req));
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authed: isAdmin(req, settings) });
});

const admin = express.Router();
admin.use(requireAdmin(settings));

// Connections with live status merged in.
admin.get('/connections', (req, res) => {
  const out = store.list().map((c) => ({
    ...c,
    hasPassword: !!c.password,
    status: poller.getState(c.id) ?? null,
  }));
  res.json({ connections: out });
});

admin.post('/connections', async (req, res) => {
  const rec = await store.create(req.body ?? {});
  res.status(201).json({ connection: rec });
});

admin.put('/connections/:id', async (req, res) => {
  const patch = { ...req.body };
  // Empty password field means "leave unchanged"; only update when provided.
  if (patch.password === '' || patch.password == null) delete patch.password;
  const rec = await store.update(req.params.id, patch);
  if (!rec) return res.status(404).json({ error: 'not-found' });
  res.json({ connection: rec });
});

admin.delete('/connections/:id', async (req, res) => {
  const ok = await store.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not-found' });
  res.json({ ok: true });
});

admin.post('/connections/:id/enable', async (req, res) => {
  const rec = await store.setEnabled(req.params.id, !!req.body?.enabled);
  if (!rec) return res.status(404).json({ error: 'not-found' });
  res.json({ connection: rec });
});

admin.post('/connections/reorder', async (req, res) => {
  const ids = Array.isArray(req.body?.order) ? req.body.order : [];
  res.json({ connections: await store.reorder(ids) });
});

// One-shot connection test — does NOT save anything.
admin.post('/test', async (req, res) => {
  const { host, port = 8088, username, password, input = 'active' } = req.body ?? {};
  if (!host) return res.json({ reachable: false, error: 'no-host' });
  const result = { reachable: false, authOk: false, inputFound: false, remainingMs: null, item: null, vmixState: null };
  try {
    const xml = await fetchVmixApi(host, port, { username, password, timeoutMs: 2500 });
    result.reachable = true;
    result.authOk = true;
    const parsed = parseVmixXml(xml, input);
    result.inputFound = parsed.inputFound;
    result.vmixState = parsed.state;
    result.remainingMs = parsed.remainingMs;
    const sel = parsed.list.find((i) => i.selected);
    result.item = sel ? sel.title : parsed.title;
  } catch (err) {
    const code = err instanceof VmixError ? err.code : 'ERR';
    result.error = code;
    if (code === 'AUTH') { result.reachable = true; result.authOk = false; }
  }
  res.json(result);
});

// Change the admin password (requires the current one).
const PasswordChange = z.object({
  current: z.string().min(1).max(200),
  next: z.string().min(12, 'at least 12 characters').max(200),
});
admin.put('/password', async (req, res) => {
  const body = PasswordChange.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message || 'invalid' });
  if (!settings.verifyAdmin(body.data.current)) return res.status(403).json({ error: 'current password is wrong' });
  await settings.setAdminPassword(body.data.next);
  await fsp.rm(path.join(__dirname, '..', 'data', 'admin-password.txt'), { force: true });
  res.json({ ok: true });
});

// Settings
admin.get('/settings', (req, res) => {
  res.json(settings.publicSettings());
});

admin.put('/settings', async (req, res) => {
  const { producerToken, tunnelMode, tunnelToken } = req.body ?? {};
  if (producerToken != null) await settings.setProducerToken(producerToken);
  const tunnelPatch = {};
  if (tunnelMode === 'named' || tunnelMode === 'quick') tunnelPatch.mode = tunnelMode;
  if (typeof tunnelToken === 'string' && tunnelToken.length) tunnelPatch.token = tunnelToken;
  if (Object.keys(tunnelPatch).length) await settings.setTunnel(tunnelPatch);
  res.json(settings.publicSettings());
});

// Tunnel control
admin.get('/tunnel/status', (req, res) => res.json(tunnel.state()));
admin.post('/tunnel/start', async (req, res) => {
  await tunnel.start();
  res.json(tunnel.state());
});
admin.post('/tunnel/stop', async (req, res) => {
  await tunnel.stop();
  res.json(tunnel.state());
});

// ---- Ingests (MediaMTX stream keys + live stats) -------------------------
const IngestCreate = z.object({ name: z.string().trim().min(1).max(60) });
const IngestPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
});

function ingestView(rec) {
  const pathName = ingestPath(rec.key);
  const host = INGEST.publicHost || '<public-ip>';
  const priv = INGEST.privateHost || '<private-ip>';
  return {
    ...rec,
    path: pathName,
    live: mediamtx.get(pathName),
    setup: {
      publisher: { rtmpServer: `rtmp://${host}/${INGEST_APP}`, streamKey: rec.key },
      vmixSrt: { host: priv, port: 8890, streamId: `read:${pathName}`, latencyMs: 200 },
      vmixRtmpUrl: `rtmp://${priv}/${pathName}`,
    },
  };
}

admin.get('/ingests', (req, res) => {
  const known = new Set(ingests.list().map((i) => ingestPath(i.key)));
  // Live paths not tied to a managed key (e.g. legacy-credential pushes).
  const other = [...mediamtx.paths.keys()].filter((n) => !known.has(n)).map((n) => mediamtx.get(n));
  res.json({
    mediamtx: { online: mediamtx.online, error: mediamtx.error },
    hosts: { publicHost: INGEST.publicHost, privateHost: INGEST.privateHost },
    ingests: ingests.list().map(ingestView),
    otherPaths: other,
  });
});

// Full metrics for one ingest: live snapshot, stream info, per-second series
// (optionally only points newer than ?since=<epoch ms>) and the event log.
admin.get('/ingests/:id/metrics', (req, res) => {
  const rec = ingests.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not-found' });
  const pathName = ingestPath(rec.key);
  const a = analyzer.get(pathName);
  const since = Number(req.query.since) || 0;
  res.json({
    ingest: { id: rec.id, name: rec.name, enabled: rec.enabled, path: pathName },
    live: mediamtx.get(pathName),
    info: a?.info ?? null,
    totals: a?.totals ?? null,
    series: a ? a.series.filter((p) => p.t > since) : [],
    events: (analyzer.events.get(pathName) || []).filter((e) => e.t > since),
    now: Date.now(),
  });
});

admin.post('/ingests', async (req, res) => {
  const body = IngestCreate.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid', issues: body.error.issues });
  res.status(201).json({ ingest: ingestView(await ingests.create(body.data)) });
});

admin.put('/ingests/:id', async (req, res) => {
  const body = IngestPatch.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid', issues: body.error.issues });
  const rec = await ingests.update(req.params.id, body.data);
  if (!rec) return res.status(404).json({ error: 'not-found' });
  res.json({ ingest: ingestView(rec) });
});

admin.post('/ingests/:id/regenerate', async (req, res) => {
  const rec = await ingests.regenerate(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not-found' });
  res.json({ ingest: ingestView(rec) });
});

admin.delete('/ingests/:id', async (req, res) => {
  if (!(await ingests.remove(req.params.id))) return res.status(404).json({ error: 'not-found' });
  res.json({ ok: true });
});

// ---- Peplink InControl2 ------------------------------------------------------
const PeplinkCfg = z.object({
  clientId: z.string().trim().max(200).optional(),
  clientSecret: z.string().trim().max(200).optional(),
  orgId: z.string().trim().max(50).optional(),
});
admin.get('/peplink', (req, res) => res.json(peplink.view()));
admin.get('/peplink/raw', (req, res) => res.json(peplink.raw));
admin.put('/peplink/config', async (req, res) => {
  const body = PeplinkCfg.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid' });
  await peplink.setConfig(body.data);
  res.json(peplink.publicConfig());
});
admin.post('/peplink/refresh', async (req, res) => { await peplink.tick(); res.json(peplink.view()); });

// ---- FusionHub live (local Peplink API over the VPC) ------------------------
const FusionHubConnect = z.object({
  host: z.string().trim().max(100).optional(),
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});
admin.get('/fusionhub', (req, res) => res.json(fusionhub.view(Number(req.query.since) || 0)));
admin.get('/fusionhub/raw', (req, res) => res.json(fusionhub.raw));
// One-time: creates a read-only API client on the FusionHub. The admin
// password is used for that single login and never stored.
admin.post('/fusionhub/connect', async (req, res) => {
  const body = FusionHubConnect.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid' });
  try {
    await fusionhub.connect(body.data);
    res.json(fusionhub.view());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Starlink (account API, read-only service account) --------------------
const StarlinkCfg = z.object({
  clientId: z.string().trim().max(200).optional(),
  clientSecret: z.string().trim().max(500).optional(),
});
admin.get('/starlink', (req, res) => res.json(starlink.view()));
admin.get('/starlink/raw', (req, res) => res.json(starlink.raw));
admin.put('/starlink/config', async (req, res) => {
  const body = StarlinkCfg.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid' });
  await starlink.setConfig(body.data);
  res.json(starlink.view());
});
admin.post('/starlink/refresh', async (req, res) => { await starlink.pollUsage(); await starlink.pollTelemetry(); res.json(starlink.view()); });

// ---- White-label shows (live.<domain>/<slug>) --------------------------------
const ShowBody = z.object({
  slug: z.string().trim().max(60).optional(),
  title: z.string().trim().max(120).optional(),
  subtitle: z.string().trim().max(200).optional(),
  playbackUrl: z.string().trim().max(500).optional(),
  logoUrl: z.string().trim().max(500).optional(),
  accent: z.string().trim().max(7).optional(),
  background: z.string().trim().max(7).optional(),
  offlineMessage: z.string().trim().max(200).optional(),
  enabled: z.boolean().optional(),
  orientation: z.enum(['horizontal', 'vertical']).optional(),
});
admin.get('/shows', (req, res) => res.json({ shows: shows.list(), liveBase: `https://${LIVE_HOST}` }));
admin.post('/shows', async (req, res) => {
  const b = ShowBody.safeParse(req.body ?? {});
  if (!b.success) return res.status(400).json({ error: 'invalid' });
  try { res.status(201).json({ show: await shows.create(b.data) }); } catch (e) { res.status(400).json({ error: e.message }); }
});
admin.put('/shows/:slug', async (req, res) => {
  const b = ShowBody.safeParse(req.body ?? {});
  if (!b.success) return res.status(400).json({ error: 'invalid' });
  try {
    const s2 = await shows.update(req.params.slug, b.data);
    if (!s2) return res.status(404).json({ error: 'not-found' });
    res.json({ show: s2 });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// ---- Field machines + support queue -----------------------------------------
const installCommand = (code) => `powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://${LIVE_HOST}/fm/install.ps1))) -Code ${code}"`;
admin.get('/field', async (req, res) => {
  res.json({
    machines: field.list().map((m) => field.publicMachine(m)),
    tickets: field.tickets(),
    kits: [...field.kits.values()].map((k) => ({ kit: k.kit, version: k.version, files: k.files?.length || 0, media: k.media?.length || 0, publishedAt: k.publishedAt || '' })),
    slack: !!field.data.slackWebhook,
    uploadsBytes: await uploadsBytes(), uploadCap: UPLOAD_CAP_BYTES,
  });
});
admin.post('/field/machines', async (req, res) => {
  try {
    const r = await field.createMachine(req.body || {});
    res.json({ ...r, command: installCommand(r.code) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
admin.post('/field/machines/:id/code', async (req, res) => {
  if (!field.get(req.params.id)) return res.status(404).json({ error: 'not-found' });
  const code = await field.newEnrollCode(req.params.id);
  res.json({ code, command: installCommand(code) });
});
admin.patch('/field/machines/:id', async (req, res) => {
  const m = await field.updateMachine(req.params.id, req.body || {});
  if (!m) return res.status(404).json({ error: 'not-found' });
  res.json({ machine: m });
});
admin.delete('/field/machines/:id', async (req, res) => {
  if (!(await field.removeMachine(req.params.id))) return res.status(404).json({ error: 'not-found' });
  res.json({ ok: true });
});
admin.post('/field/tickets/:id/reply', async (req, res) => {
  const t = field.ticket(req.params.id);
  if (!t) return res.status(404).json({ error: 'not-found' });
  await field.reply(t, req.body?.text, 'GlassFire');
  res.json({ ticket: t });
});
admin.post('/field/tickets/:id/status', async (req, res) => {
  const t = field.ticket(req.params.id);
  if (!t) return res.status(404).json({ error: 'not-found' });
  res.json({ ticket: await field.setTicketStatus(t, req.body?.status) });
});
admin.get('/field/tickets/:id/files/:name', (req, res) => {
  const t = field.ticket(req.params.id);
  const f = t?.files.find((x) => x.name === req.params.name);
  if (!f) return res.status(404).json({ error: 'not-found' });
  res.download(path.join(UPLOADS_DIR, t.id, f.name), f.name);
});
admin.put('/field/slack', async (req, res) => {
  try { await field.setSlack(req.body?.url); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
admin.post('/field/slack/test', async (req, res) => {
  res.json({ ok: await slackNotify(':white_check_mark: GlassFire Live Tools can post to this channel.') });
});
// ---- Show schedules (blocks + countdown events, with running early/late) -----
async function scheduleView(kitId) {
  const kit = await kitWithSchedule(kitId);
  const s = schedules.get(kitId);
  if (!s || !kit) return null;
  return {
    kit: s.kit, title: s.title, version: s.version, updatedAt: s.updatedAt, kitVersion: kit.version,
    items: s.items.map((i) => ({ ...i, effective: effective(i) })),
    machines: field.list().filter((m) => m.kit === kitId).map((m) => {
      const p = field.publicMachine(m);
      return { id: m.id, name: m.name, role: m.role, online: p.online, expired: p.expired, synced: m.status?.kitVersion === kit.version, kitVersion: m.status?.kitVersion || '', lastSeen: m.lastSeen };
    }),
  };
}
admin.get('/schedules', async (req, res) => {
  await field.refreshKits();
  for (const k of field.kits.values()) await kitWithSchedule(k.kit);
  res.json({ schedules: schedules.list().map((s) => ({ kit: s.kit, title: s.title, version: s.version, items: s.items.length })) });
});
admin.get('/schedules/:kit', async (req, res) => {
  const v = await scheduleView(req.params.kit);
  if (!v) return res.status(404).json({ error: 'not-found' });
  res.json(v);
});
admin.post('/schedules/:kit/items', async (req, res) => {
  try {
    const it = await schedules.add(req.params.kit, req.body || {});
    if (!it) return res.status(404).json({ error: 'not-found' });
    res.json(await scheduleView(req.params.kit));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
admin.patch('/schedules/:kit/items/:id', async (req, res) => {
  try {
    const it = await schedules.update(req.params.kit, req.params.id, req.body || {});
    if (!it) return res.status(404).json({ error: 'not-found' });
    res.json(await scheduleView(req.params.kit));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
admin.post('/schedules/:kit/items/:id/shift', async (req, res) => {
  const seconds = req.body?.text != null ? parseShift(req.body.text) : Math.round(Number(req.body?.seconds));
  if (!Number.isFinite(seconds) || !seconds || Math.abs(seconds) > 4 * 3600) return res.status(400).json({ error: 'Enter a shift like 3, 2:30, 30s or -1 (up to 4 hours)' });
  const moved = await schedules.shift(req.params.kit, req.params.id, seconds, !!req.body?.following);
  if (!moved) return res.status(404).json({ error: 'not-found' });
  res.json(await scheduleView(req.params.kit));
});
admin.delete('/schedules/:kit/items/:id', async (req, res) => {
  if (!(await schedules.remove(req.params.kit, req.params.id))) return res.status(404).json({ error: 'not-found' });
  res.json(await scheduleView(req.params.kit));
});

admin.post('/field/kits/reload',async (req, res) => { await field.loadKits(); res.json({ kits: [...field.kits.keys()] }); });

admin.get('/screen-checks',(req, res) => res.json({ checks: screenChecks.list(), checkUrl: `https://${LIVE_HOST}/check` }));
admin.delete('/screen-checks', async (req, res) => { await screenChecks.clear(); res.json({ ok: true }); });
admin.delete('/screen-checks/:id', async (req, res) => {
  if (!(await screenChecks.remove(req.params.id))) return res.status(404).json({ error: 'not-found' });
  res.json({ ok: true });
});
admin.delete('/shows/:slug', async (req, res) => {
  if (!(await shows.remove(req.params.slug))) return res.status(404).json({ error: 'not-found' });
  res.json({ ok: true });
});

// ---- vMix machines + vMix Call guests -------------------------------------
const MachineBody = z.object({
  label: z.string().trim().min(1).max(40),
  host: z.string().trim().min(1).max(100),
  port: z.coerce.number().int().min(1).max(65535).default(8088),
  username: z.string().max(100).optional().default(''),
  password: z.string().max(200).optional().default(''),
});
admin.get('/vmix', (req, res) => res.json({ machines: calls.machinesView() }));
admin.post('/vmix', async (req, res) => {
  const body = MachineBody.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid', issues: body.error.issues });
  res.status(201).json({ machine: await calls.addMachine(body.data) });
});
admin.put('/vmix/:id', async (req, res) => {
  const body = MachineBody.partial().safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid' });
  const m = await calls.updateMachine(req.params.id, body.data);
  if (!m) return res.status(404).json({ error: 'not-found' });
  res.json({ ok: true });
});
admin.delete('/vmix/:id', async (req, res) => {
  if (!(await calls.removeMachine(req.params.id))) return res.status(404).json({ error: 'not-found' });
  res.json({ ok: true });
});

const InviteBody = z.object({
  machineId: z.string().min(1),
  inputKey: z.string().min(1),
  guestName: z.string().trim().max(60).optional().default(''),
  show: z.string().trim().max(80).optional().default(''),
});
admin.get('/guests', (req, res) => res.json({ invites: calls.invitesView(), joinBase: JOIN_PUBLIC_BASE }));
admin.post('/guests', async (req, res) => {
  const body = InviteBody.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid' });
  const inv = await calls.createInvite(body.data);
  if (!inv) return res.status(404).json({ error: 'call input not found on that vMix' });
  res.status(201).json({ invite: inv, link: `${JOIN_PUBLIC_BASE}/join/${inv.code}` });
});
admin.delete('/guests/:code', async (req, res) => {
  if (!(await calls.removeInvite(req.params.code))) return res.status(404).json({ error: 'not-found' });
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// ---------------------------------------------------------------------------
// WebSocket — push current snapshot on connect, then live updates
// ---------------------------------------------------------------------------
wss.on('connection', (ws, req) => {
  // Enforce producer token on the WS handshake too.
  const url = new URL(req.url, 'http://localhost');
  const k = url.searchParams.get('k');
  const token = settings.producerToken;
  if (!isAdmin(req, settings) && (!token || k !== token)) {
    ws.close(4401, 'unauthorized');
    return;
  }
  ws.send(JSON.stringify({ type: 'hello', streams: poller.publicStreams(), states: poller.snapshot() }));
});

// ---------------------------------------------------------------------------
// MediaMTX auth hook (loopback-only listener; MediaMTX POSTs every action here)
// ---------------------------------------------------------------------------
const AuthReq = z.object({
  action: z.string(),
  path: z.string().optional().default(''),
  ip: z.string().optional().default(''),
  user: z.string().optional().default(''),
  password: z.string().optional().default(''),
  protocol: z.string().optional(),
}).passthrough();

const hook = express();
hook.disable('x-powered-by');
hook.use(express.json({ limit: '32kb' }));
hook.post('/mediamtx/auth', (req, res) => {
  const parsed = AuthReq.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).end();
  const r = parsed.data;
  const d = decideAuth(r, { ingests: ingests.list(), legacy: ingests.legacy, readCidrs: INGEST.readCidrs });
  if (!d.allow && r.action === 'publish' && (r.user || r.path)) {
    console.warn(`[ingest] denied publish ${r.protocol || ''} path=${r.path} ip=${r.ip} (${d.reason})`);
  }
  res.status(d.allow ? 200 : 401).end();
});
const hookServer = http.createServer(hook);
hookServer.listen(AUTH_HOOK_PORT, '127.0.0.1', () => {
  console.log(`[ingest] MediaMTX auth hook on http://127.0.0.1:${AUTH_HOOK_PORT}/mediamtx/auth`);
});

// ---------------------------------------------------------------------------
// HTML fragments
// ---------------------------------------------------------------------------
function producerDeniedPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Access required</title>
<style>body{background:#0b0e14;color:#e6edf3;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}
.box{text-align:center;max-width:30rem;padding:2rem}</style></head>
<body><div class="box"><h1>Access token required</h1>
<p>This producer link needs an access key. Append <code>?k=YOUR_TOKEN</code> to the URL.</p></div></body></html>`;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
server.listen(PORT, async () => {
  console.log(`[hub] producer + admin on http://localhost:${PORT}  (admin: /admin)`);
  if (settings.generatedAdminPassword) {
    // Surface the one-time plaintext ONLY to a gitignored, owner-only file. Never
    // to the console: under systemd that lands in the journal.
    const pwFile = path.join(__dirname, '..', 'data', 'admin-password.txt');
    await fsp.writeFile(pwFile, `${settings.generatedAdminPassword}\n`, { encoding: 'utf8', mode: 0o600 }).catch(() => {});
    console.log(`[hub] Generated an admin password and saved it once to ${pwFile}. Store it, then delete that file.`);
  }
  // Auto-start the tunnel when a named token exists, or quick mode is selected.
  const cfg = settings.tunnel;
  if ((cfg.mode === 'named' && cfg.token) || cfg.mode === 'quick') {
    tunnel.start().catch((e) => console.error('[tunnel] start failed:', e.message));
  } else {
    console.log('[tunnel] no named token set; start from /admin once configured (or set quick mode).');
  }
});

async function shutdown(signal) {
  console.log(`\n[hub] ${signal} — shutting down`);
  poller.stop();
  mediamtx.stop();
  analyzer.stop();
  services.stop();
  calls.stop();
  peplink.stop();
  starlink.stop();
  fusionhub.stop();
  hookServer.close();
  await tunnel.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };
