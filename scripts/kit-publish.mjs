#!/usr/bin/env node
// Publish a show kit to the hub so field computers pick it up on their next check-in.
//
//   node scripts/kit-publish.mjs kits/equip26.json            build + upload
//   node scripts/kit-publish.mjs kits/equip26.json --dry-run  build only (prints the manifest)
//
// Kit files (presets, countdown, scripts, Companion pages) are copied to the hub
// (data/kits/<kit>/files) and served to enrolled machines. Media is hashed and
// listed so machines can verify it; it is downloaded only when the kit gives it
// a URL (S3), otherwise it is reported missing until copied on site.
//
// Transforms applied on the way out (the source files are not changed):
//   countdown     bakes in the licence end date and strips comments/indentation
//   autoswitch-X  sets FMT to "H" or "V" in the vMix auto-switch script
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const [, , defPath, ...flags] = process.argv;
if (!defPath) { console.error('usage: node scripts/kit-publish.mjs kits/<kit>.json [--dry-run]'); process.exit(1); }
const dry = flags.includes('--dry-run');
const HOST = process.env.DEPLOY_HOST || 'ec2-user@13.216.6.158';
const KEY = process.env.DEPLOY_KEY || path.join(os.homedir(), '.ssh', 'gf.pem');
const APP = '/opt/glassfire-tools';

const def = JSON.parse(await fs.readFile(defPath, 'utf8'));
const CACHE = path.join(path.dirname(defPath), `.${def.kit}.hashcache.json`);
const cache = JSON.parse(await fs.readFile(CACHE, 'utf8').catch(() => '{}'));

const shaBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function shaFile(p) {
  const st = await fs.stat(p);
  const k = `${p}|${st.size}|${st.mtimeMs}`;
  if (cache[k]) return { sha256: cache[k], size: st.size };
  const h = crypto.createHash('sha256');
  await new Promise((res, rej) => createReadStream(p).on('data', (d) => h.update(d)).on('end', res).on('error', rej));
  cache[k] = h.digest('hex');
  return { sha256: cache[k], size: st.size };
}

function transform(name, buf) {
  if (!name) return buf;
  let s = buf.toString('utf8');
  if (name === 'countdown') {
    const exp = Date.parse(def.countdownExpires);
    if (!exp) throw new Error('countdownExpires missing');
    s = s.replace(/<!--[\s\S]*?-->\s*/g, '');
    if (!s.includes('function tick() {')) throw new Error('countdown: tick() not found');
    s = s.replace('(function () {', `var EXPIRES = ${exp};\n(function () {`)
      .replace('function tick() {', "function tick() {\n    if (Date.now() > EXPIRES) { document.getElementById('bar').classList.remove('show'); return; }");
    // Strip whole-line JS comments and indentation (keeps strings and URLs intact).
    s = s.split('\n').filter((l) => !/^\s*\/\/(?!\/)/.test(l)).map((l) => l.trim()).filter(Boolean).join('\n');
  } else if (/^autoswitch-[HV]$/.test(name)) {
    const fmt = name.slice(-1);
    if (!/Dim FMT As String = "[HV]"/.test(s)) throw new Error('autoswitch: FMT line not found');
    s = s.replace(/Dim FMT As String = "[HV]"/, `Dim FMT As String = "${fmt}"`);
  } else throw new Error(`unknown transform ${name}`);
  return Buffer.from(s, 'utf8');
}

function globToRe(g) {
  return new RegExp('^' + g.split('/').map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('/') + '$', 'i');
}
async function walk(dir, base = '') {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walk(path.join(dir, e.name), rel)); else out.push(rel);
  }
  return out;
}

const version = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const stage = await fs.mkdtemp(path.join(os.tmpdir(), `kit-${def.kit}-`));
const filesDir = path.join(stage, def.kit, 'files');
const manifest = { kit: def.kit, title: def.title || def.kit, version, root: def.root, startup: def.startup || {}, publishedAt: new Date().toISOString(), files: [], media: [] };
// Starting schedule; only used the first time the hub sees this kit (then edited on livetools).
if (def.schedule) manifest.scheduleSeed = def.schedule;
// Media in S3 (uploaded with kit-media-upload.mjs): the hub signs download links.
if (def.mediaS3) manifest.mediaS3 = def.mediaS3;

for (const f of def.files) {
  const src = path.join(def.source, ...f.path.split('/'));
  const out = transform(f.transform, await fs.readFile(src));
  const rel = f.as || f.path;
  // Two roles can publish different bytes to the same path: keep them apart on the hub.
  const stored = f.as && f.role !== 'all' ? `${rel}.${f.role}` : rel;
  await fs.mkdir(path.dirname(path.join(filesDir, ...stored.split('/'))), { recursive: true });
  await fs.writeFile(path.join(filesDir, ...stored.split('/')), out);
  manifest.files.push({ path: rel, stored, role: f.role || 'all', apply: f.apply || '', owned: true, sha256: shaBuf(out), size: out.length });
}

const all = await walk(def.source);
for (const m of def.media) {
  const re = globToRe(m.glob);
  const hits = all.filter((p) => re.test(p));
  if (!hits.length) console.warn(`! no media matched ${m.glob}`);
  for (const p of hits) {
    const { sha256, size } = await shaFile(path.join(def.source, ...p.split('/')));
    manifest.media.push({ path: p, role: m.role || 'all', sha256, size, url: m.urlBase ? `${m.urlBase}/${p.split('/').map(encodeURIComponent).join('/')}` : '' });
  }
}
await fs.writeFile(CACHE, JSON.stringify(cache));
await fs.writeFile(path.join(stage, def.kit, 'manifest.json'), JSON.stringify(manifest, null, 2));

const mediaGB = manifest.media.reduce((n, f) => n + f.size, 0) / 1024 ** 3;
console.log(`kit ${def.kit} ${version}: ${manifest.files.length} kit files, ${manifest.media.length} media files (${mediaGB.toFixed(1)} GB, not uploaded)`);
for (const f of manifest.files) console.log(`  ${f.role.padEnd(3)} ${f.path}  ${f.sha256.slice(0, 12)}  ${f.size} B${f.apply ? `  [${f.apply}]` : ''}`);
if (dry) { console.log(`dry run: staged at ${stage}`); process.exit(0); }

// Upload: tar the staged kit, swap it in atomically on the hub.
// Relative paths only: GNU tar and scp read "C:\..." as a remote host.
execFileSync('tar', ['-czf', 'kit.tgz', def.kit], { stdio: 'inherit', cwd: stage });
const ssh = ['-i', KEY, '-o', 'LogLevel=ERROR'];
execFileSync('scp', [...ssh, 'kit.tgz', `${HOST}:/tmp/kit-${def.kit}.tgz`], { stdio: 'inherit', cwd: stage });
execFileSync('ssh', [...ssh, HOST, [
  'set -e', `mkdir -p ${APP}/data/kits`, `cd ${APP}/data/kits`,
  `rm -rf .${def.kit}.new && mkdir .${def.kit}.new && tar -xzf /tmp/kit-${def.kit}.tgz -C .${def.kit}.new`,
  `rm -rf .${def.kit}.old && { [ -d ${def.kit} ] && mv ${def.kit} .${def.kit}.old || true; }`,
  `mv .${def.kit}.new/${def.kit} ${def.kit} && rm -rf .${def.kit}.new .${def.kit}.old /tmp/kit-${def.kit}.tgz`,
  `echo published ${def.kit} ${version}`,
].join(' && ')], { stdio: 'inherit' });
await fs.rm(stage, { recursive: true, force: true });
