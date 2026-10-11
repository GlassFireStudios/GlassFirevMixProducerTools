// White-label shows: one public watch page per show at live.glassfire.co/<slug>.
//
// A show is just presentation + where to play from (an IVS playback URL, which
// is public by design). Nothing GlassFire-branded is rendered unless the show
// asks for it. Persisted to data/shows.json.

import { promises as fs } from 'fs';
import path from 'path';
import { atomicWrite } from './atomic.js';
import { slugify } from './store.js';

const FILE = path.resolve('data', 'shows.json');
const HEX = /^#[0-9a-f]{6}$/i;

export function cleanShow(input, prev = {}) {
  const s = { ...prev };
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  if (input.title != null) s.title = str(input.title, 120);
  if (input.subtitle != null) s.subtitle = str(input.subtitle, 200);
  if (input.playbackUrl != null) {
    const u = str(input.playbackUrl, 500);
    if (u && !/^https:\/\/[\w.-]+\.live-video\.net\/.+\.m3u8$/.test(u) && !/^https:\/\/.+\.m3u8$/.test(u)) throw new Error('Playback URL must be an https .m3u8 URL');
    s.playbackUrl = u;
  }
  if (input.logoUrl != null) {
    const u = str(input.logoUrl, 500);
    if (u && !/^https:\/\//.test(u)) throw new Error('Logo URL must start with https://');
    s.logoUrl = u;
  }
  if (input.accent != null) s.accent = HEX.test(input.accent) ? input.accent : '#ffffff';
  if (input.background != null) s.background = HEX.test(input.background) ? input.background : '#000000';
  if (input.offlineMessage != null) s.offlineMessage = str(input.offlineMessage, 200);
  if (input.enabled != null) s.enabled = !!input.enabled;
  if (input.orientation != null) s.orientation = input.orientation === 'vertical' ? 'vertical' : 'horizontal';
  return s;
}

// What the public page is allowed to see.
export function publicShow(s) {
  return {
    slug: s.slug, title: s.title, subtitle: s.subtitle || '', playbackUrl: s.playbackUrl || '',
    logoUrl: s.logoUrl || '', accent: s.accent || '#ffffff', background: s.background || '#000000',
    offlineMessage: s.offlineMessage || 'The stream will begin shortly.',
    orientation: s.orientation === 'vertical' ? 'vertical' : 'horizontal',
  };
}

export class Shows {
  constructor() { this.data = { shows: [] }; }

  async load() {
    try { this.data = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }

  _save() { return atomicWrite(FILE, JSON.stringify(this.data, null, 2)); }
  list() { return this.data.shows; }
  get(slug) { return this.list().find((s) => s.slug === slug) || null; }

  async create(input) {
    let slug = slugify(input.slug || input.title || 'show');
    for (let n = 2; this.get(slug); n += 1) slug = `${slugify(input.slug || input.title)}-${n}`;
    const s = cleanShow({ enabled: true, accent: '#ffffff', background: '#000000', ...input }, { slug, createdAt: Date.now() });
    if (!s.title) s.title = slug;
    this.list().push(s);
    await this._save();
    return s;
  }

  async update(slug, input) {
    const i = this.list().findIndex((s) => s.slug === slug);
    if (i < 0) return null;
    this.data.shows[i] = cleanShow(input, this.list()[i]);
    await this._save();
    return this.data.shows[i];
  }

  async remove(slug) {
    const before = this.list().length;
    this.data.shows = this.list().filter((s) => s.slug !== slug);
    if (this.list().length === before) return false;
    await this._save();
    return true;
  }
}
