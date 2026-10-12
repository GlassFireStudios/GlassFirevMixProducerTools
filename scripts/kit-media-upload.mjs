#!/usr/bin/env node
// Upload a kit's media to S3 so show computers can download it themselves.
//
//   node scripts/kit-media-upload.mjs kits/equip26.json
//
// Uses the kit's media globs and the hash cache from kit-publish. The hub signs
// one PUT URL per file (skipping files S3 already has with the same SHA-256);
// the bytes go straight from this computer to S3. Run kit-publish afterwards so
// the manifest points machines at S3.
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { Readable } from 'stream';

const [, , defPath] = process.argv;
if (!defPath) { console.error('usage: node scripts/kit-media-upload.mjs kits/<kit>.json'); process.exit(1); }
const HOST = process.env.DEPLOY_HOST || 'ec2-user@13.216.6.158';
const KEY = process.env.DEPLOY_KEY || path.join(os.homedir(), '.ssh', 'gf.pem');
const def = JSON.parse(await fs.readFile(defPath, 'utf8'));
if (!def.mediaS3) { console.error('kit has no "mediaS3" prefix'); process.exit(1); }
const CACHE = path.join(path.dirname(defPath), `.${def.kit}.hashcache.json`);
const cache = JSON.parse(await fs.readFile(CACHE, 'utf8').catch(() => '{}'));

async function shaFile(p) {
  const st = await fs.stat(p);
  const k = `${p}|${st.size}|${st.mtimeMs}`;
  if (!cache[k]) {
    const h = crypto.createHash('sha256');
    await new Promise((res, rej) => createReadStream(p).on('data', (d) => h.update(d)).on('end', res).on('error', rej));
    cache[k] = h.digest('hex');
  }
  return { sha256: cache[k], size: st.size };
}
const globToRe = (g) => new RegExp('^' + g.split('/').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('/') + '$', 'i');
async function walk(dir, base = '') {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walk(path.join(dir, e.name), rel)); else out.push(rel);
  }
  return out;
}

const all = await walk(def.source);
const files = [];
for (const m of def.media) {
  const re = globToRe(m.glob);
  for (const rel of all.filter((p) => re.test(p))) {
    const { sha256, size } = await shaFile(path.join(def.source, ...rel.split('/')));
    files.push({ rel, key: `${def.mediaS3}${rel}`, size, sha256 });
  }
}
await fs.writeFile(CACHE, JSON.stringify(cache));

const signed = JSON.parse(execFileSync('ssh', ['-i', KEY, '-o', 'LogLevel=ERROR', HOST, 'cd /opt/glassfire-tools && node scripts/media-presign.mjs'],
  { input: JSON.stringify(files.map(({ key, size, sha256 }) => ({ key, size, sha256 }))), maxBuffer: 16 * 1024 * 1024 }).toString());

let sent = 0, skipped = 0;
const totalGB = files.reduce((n, f) => n + f.size, 0) / 1024 ** 3;
console.log(`${files.length} media files, ${totalGB.toFixed(1)} GB`);
for (const f of files) {
  const s = signed.find((x) => x.key === f.key);
  if (s?.have) { skipped += 1; continue; }
  const t0 = Date.now();
  const body = Readable.toWeb(createReadStream(path.join(def.source, ...f.rel.split('/'))));
  const res = await fetch(s.url, { method: 'PUT', body, duplex: 'half', headers: { 'Content-Length': String(f.size) } });
  if (!res.ok) { console.error(`! ${f.rel}: ${res.status} ${(await res.text()).slice(0, 300)}`); process.exitCode = 1; continue; }
  sent += 1;
  const secs = (Date.now() - t0) / 1000;
  console.log(`  up ${f.rel}  ${(f.size / 1048576).toFixed(0)} MB in ${secs.toFixed(0)} s (${((f.size * 8) / secs / 1e6).toFixed(0)} Mbps)`);
}
console.log(`done: ${sent} uploaded, ${skipped} already in S3`);
