#!/usr/bin/env node
// Runs ON THE HUB (it has the S3 instance role). Reads a JSON list of
// { key, size, sha256 } on stdin and prints, for each, either { key, have: true }
// when S3 already holds that exact file, or { key, url } to PUT it to.
// Called over SSH by scripts/kit-media-upload.mjs.
import { head, signPut } from '../src/media.js';

const input = JSON.parse(await new Promise((res) => { let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => res(s)); }));
const out = [];
for (const f of input) {
  const h = await head(f.key);
  if (h && h.size === f.size && h.sha256 === f.sha256) out.push({ key: f.key, have: true });
  else out.push({ key: f.key, url: await signPut(f.key, f.size, f.sha256) });
}
process.stdout.write(JSON.stringify(out));
