// GlassFire vMix Producer Tools — hub.
//
// Serves producer views (public, optionally token-gated) and a Companion-style
// admin dashboard (password gated), polls every enabled vMix connection, and
// broadcasts live countdown state over WebSocket. Also drives the Cloudflare
// tunnel that fronts the producer views at https://liveproducers.glassfire.co.

import express from 'express';
import http from 'http';
import path from 'path';
import { promises as fsp } from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { ConnectionStore, publicView } from './store.js';
import { Settings, PRODUCER_PORT_DEFAULT } from './settings.js';
import { Poller } from './poller.js';
import { TunnelManager } from './tunnel.js';
import { fetchVmixApi, parseVmixXml, VmixError } from './vmix.js';
import {
  requireAdmin, isAdmin, issueSession, setSessionCookie, clearSessionCookie,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || PRODUCER_PORT_DEFAULT;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
const store = new ConnectionStore();
const settings = new Settings();
await settings.load();
await store.load();

const app = express();
app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');

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
app.get('/', gateProducer, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/grid.html', gateProducer, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'grid.html')));
app.get('/s/:id', gateProducer, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'stream.html')));

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
app.use(express.static(PUBLIC_DIR, { index: false, extensions: [] }));

// ---------------------------------------------------------------------------
// Admin dashboard (gated)
// ---------------------------------------------------------------------------
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

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
    // Surface the one-time plaintext to a gitignored file (never committed/logged
    // to a tracked path) and the console, so it can be saved to a password manager.
    const pwFile = path.join(__dirname, '..', 'data', 'admin-password.txt');
    await fsp.writeFile(pwFile, `${settings.generatedAdminPassword}\n`, 'utf8').catch(() => {});
    console.log('[hub] ──────────────────────────────────────────────');
    console.log(`[hub] Generated admin password: ${settings.generatedAdminPassword}`);
    console.log(`[hub] Saved once to ${pwFile} — store it, then delete that file.`);
    console.log('[hub] ──────────────────────────────────────────────');
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
  await tunnel.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };
