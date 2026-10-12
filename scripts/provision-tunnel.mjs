// One-time Cloudflare named-tunnel provisioning.
//
// Creates (or reuses) a remotely-managed tunnel "glassfire-liveproducers",
// configures its ingress to point liveproducers.glassfire.co -> the local hub,
// creates the proxied CNAME in the glassfire.co zone, and writes the tunnel
// token into data/settings.json (named mode). The token is never printed or
// committed.
//
// Runs automatically during build IF CLOUDFLARE_API_TOKEN is set; otherwise it
// exits cleanly and the manual steps are documented in SETUP.md.
//
// Required API token scopes:
//   Account > Cloudflare Tunnel > Edit
//   Zone    > DNS > Edit
//   Zone    > Zone > Read   (on glassfire.co)

import { promises as fs } from 'fs';
import path from 'path';
import { atomicWrite } from '../src/atomic.js';

const API = 'https://api.cloudflare.com/client/v4';
const ZONE_NAME = 'glassfire.co';
const SUBDOMAIN = 'liveproducers';
const HOSTNAME = `${SUBDOMAIN}.${ZONE_NAME}`;
const TUNNEL_NAME = 'glassfire-liveproducers';
const LOCAL_SERVICE = 'http://localhost:8090';

const token = process.env.CLOUDFLARE_API_TOKEN;

function log(...a) { console.log('[provision]', ...a); }

if (!token) {
  log('CLOUDFLARE_API_TOKEN not set — skipping automatic provisioning.');
  log('Follow the manual steps in SETUP.md (Zero Trust > Networks > Tunnels), then paste the token in /admin.');
  process.exit(0);
}

async function cf(method, pathname, body) {
  const res = await fetch(API + pathname, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = (json.errors && json.errors.map((e) => `${e.code} ${e.message}`).join('; ')) || res.statusText;
    throw new Error(`CF ${method} ${pathname} failed: ${msg}`);
  }
  return json.result;
}

async function resolveAccountId() {
  if (process.env.CF_ACCOUNT_ID) return process.env.CF_ACCOUNT_ID;
  const accounts = await cf('GET', '/accounts?per_page=50');
  if (!accounts?.length) throw new Error('No accounts visible to this API token');
  if (accounts.length > 1) log(`multiple accounts; using first: ${accounts[0].name}`);
  return accounts[0].id;
}

async function resolveZoneId() {
  const zones = await cf('GET', `/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (!zones?.length) throw new Error(`Zone ${ZONE_NAME} not found for this token`);
  return zones[0].id;
}

async function findTunnel(acct) {
  const list = await cf('GET', `/accounts/${acct}/cfd_tunnel?name=${encodeURIComponent(TUNNEL_NAME)}&is_deleted=false`);
  return list?.find((t) => t.name === TUNNEL_NAME) || null;
}

async function getTunnelToken(acct, id) {
  // Returns the connector token string.
  return cf('GET', `/accounts/${acct}/cfd_tunnel/${id}/token`);
}

async function upsertCname(zone, tunnelId) {
  const target = `${tunnelId}.cfargotunnel.com`;
  const existing = await cf('GET', `/zones/${zone}/dns_records?type=CNAME&name=${encodeURIComponent(HOSTNAME)}`);
  const body = { type: 'CNAME', name: HOSTNAME, content: target, proxied: true, ttl: 1 };
  if (existing?.length) {
    await cf('PUT', `/zones/${zone}/dns_records/${existing[0].id}`, body);
    return 'updated';
  }
  await cf('POST', `/zones/${zone}/dns_records`, body);
  return 'created';
}

async function writeToken(tunnelToken) {
  const file = path.resolve('data', 'settings.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let data = {};
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* fresh */ }
  data.tunnel = { ...(data.tunnel || {}), mode: 'named', token: tunnelToken, hostname: HOSTNAME };
  await atomicWrite(file, JSON.stringify(data, null, 2));
}

async function main() {
  const acct = await resolveAccountId();
  log(`account: ${acct}`);
  const zone = await resolveZoneId();
  log(`zone ${ZONE_NAME}: ${zone}`);

  let tunnel = await findTunnel(acct);
  if (tunnel) {
    log(`reusing existing tunnel "${TUNNEL_NAME}" (${tunnel.id})`);
  } else {
    tunnel = await cf('POST', `/accounts/${acct}/cfd_tunnel`, { name: TUNNEL_NAME, config_src: 'cloudflare' });
    log(`created tunnel "${TUNNEL_NAME}" (${tunnel.id})`);
  }

  // Ingress configuration (remotely-managed).
  await cf('PUT', `/accounts/${acct}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: {
      ingress: [
        { hostname: HOSTNAME, service: LOCAL_SERVICE },
        { service: 'http_status:404' },
      ],
    },
  });
  log(`ingress set: ${HOSTNAME} -> ${LOCAL_SERVICE}`);

  const dns = await upsertCname(zone, tunnel.id);
  log(`DNS CNAME ${HOSTNAME} -> ${tunnel.id}.cfargotunnel.com (${dns})`);

  const tunnelToken = await getTunnelToken(acct, tunnel.id);
  await writeToken(tunnelToken);
  log('tunnel token written to data/settings.json (named mode)');

  log('');
  log('Provisioning complete:');
  log(`  Tunnel:   ${TUNNEL_NAME} (${tunnel.id})`);
  log(`  Hostname: https://${HOSTNAME}`);
  log(`  Service:  ${LOCAL_SERVICE}`);
  log('Start the hub (npm start) and the named tunnel will connect automatically.');
}

main().catch((err) => {
  console.error('[provision] ERROR:', err.message);
  process.exit(1);
});
