// Builds the Live Tools streaming sub-mark from the official GlassFire gradient
// icon: the mark itself is untouched (no recolour, outline or rotation); broadcast
// arcs in the brand "spark" gradient sit either side of it.
//
//   node scripts/build-icon.mjs [path/to/glassfirebrandassets]
//
// Writes public/brand/livetools-icon.svg. Re-run if the official icon changes.

import { promises as fs } from 'fs';
import path from 'path';

const assets = process.argv[2] || path.resolve('..', 'glassfirebrandassets');
const src = await fs.readFile(path.join(assets, 'GlassFire Design System', 'assets', 'icon-color.svg'), 'utf8');

const defs = src.match(/<defs>([\s\S]*?)<\/defs>/)[1];
const paths = src.slice(src.indexOf('</defs>') + 7, src.lastIndexOf('</svg>')).trim();

// Mark bounds in the 2048 source box (measured from the paths).
const MARK = { cx: 1030, cy: 965 };
const SCALE = 0.6;
const C = { x: 1024, y: 1024 };

function arc(r, side) {
  const a = (35 * Math.PI) / 180;
  const dx = r * Math.cos(a) * side;
  const dy = r * Math.sin(a);
  // Sweep through the horizontal on each side.
  return `M ${(C.x + dx).toFixed(1)} ${(C.y - dy).toFixed(1)} A ${r} ${r} 0 0 ${side > 0 ? 1 : 0} ${(C.x + dx).toFixed(1)} ${(C.y + dy).toFixed(1)}`;
}

const stroke = 'stroke="url(#gf-spark)" stroke-width="92" stroke-linecap="round" fill="none"';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="150 150 1748 1748">
  <title>GlassFire Live Tools</title>
  <defs>${defs}
    <linearGradient id="gf-spark" x1="0" y1="0" x2="2048" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#00A8E4"/><stop offset=".35" stop-color="#3C5BA9"/>
      <stop offset=".65" stop-color="#E50981"/><stop offset="1" stop-color="#EE2750"/>
    </linearGradient>
  </defs>
  <g transform="translate(${C.x} ${C.y}) scale(${SCALE}) translate(${-MARK.cx} ${-MARK.cy})">
    ${paths}
  </g>
  <path d="${arc(600, -1)}" ${stroke}/>
  <path d="${arc(810, -1)}" ${stroke}/>
  <path d="${arc(600, 1)}" ${stroke}/>
  <path d="${arc(810, 1)}" ${stroke}/>
</svg>
`;

await fs.mkdir('public/brand', { recursive: true });
await fs.writeFile('public/brand/livetools-icon.svg', svg, 'utf8');
console.log('wrote public/brand/livetools-icon.svg');
