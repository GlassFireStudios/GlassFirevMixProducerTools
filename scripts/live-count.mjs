// Prints how many things are live right now (used by scripts/deploy.sh):
// online MediaMTX paths + known vMix machines that are recording or streaming.
import { promises as fs } from 'fs';

const api = process.env.MEDIAMTX_API || 'http://127.0.0.1:9997';
let n = 0;
try {
  const j = await (await fetch(`${api}/v3/paths/list`, { signal: AbortSignal.timeout(2000) })).json();
  n += (j.items || []).filter((p) => p.ready || p.online).length;
} catch { /* MediaMTX down: nothing live through it */ }

let machines = [];
try { machines = JSON.parse(await fs.readFile('data/vmix-machines.json', 'utf8')).machines || []; } catch {}
const busy = await Promise.all(machines.map(async (m) => {
  try {
    const headers = m.password ? { Authorization: `Basic ${Buffer.from(`${m.username}:${m.password}`).toString('base64')}` } : {};
    const xml = await (await fetch(`http://${m.host}:${m.port}/api`, { headers, signal: AbortSignal.timeout(1500) })).text();
    return /<recording[^>]*>True|<streaming[^>]*>True/.test(xml);
  } catch { return false; }
}));
n += busy.filter(Boolean).length;
console.log(n);
