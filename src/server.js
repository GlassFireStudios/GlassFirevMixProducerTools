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

// Public guest hostname: serves ONLY the guest join flow, never the dashboard.
const JOIN_HOST = (process.env.JOIN_HOST || 'join.glassfire.co').toLowerCase();
const JOIN_PUBLIC_BASE = process.env.JOIN_PUBLIC_BASE || `https://${JOIN_HOST}`;

const app = express();
app.disable('x-powered-by');
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
async function sendPage(res, file) {
  let html = pageCache.get(file);
  if (!html) {
    html = (await fsp.readFile(path.join(PUBLIC_DIR, file), 'utf8'))
      .replace(/(href|src)="(\/[\w./-]+\.(?:css|js))"/g, `$1="$2?v=${APP_VERSION}"`);
    pageCache.set(file, html);
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
}

// ---------------------------------------------------------------------------
// Producer access-token gate (optional)
// ---------------------------------------------------------------------------
function producerAllowed(req) {
  const token = settings.producerToken;
  if (!token) return true;
  if (isAdmin(req, settings)) return true; // admins always pass
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

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body ?? {};
  if (!settings.verifyAdmin(password)) return res.status(401).json({ error: 'bad-password' });
  setSessionCookie(res, issueSession(settings.sessionSecret));
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
  if (token && k !== token && !isAdmin(req, settings)) {
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
  hookServer.close();
  await tunnel.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };
