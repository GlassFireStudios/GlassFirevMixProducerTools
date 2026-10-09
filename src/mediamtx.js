// MediaMTX monitor.
//
// Polls MediaMTX's local Control API (paths + RTMP/SRT connections) once a
// second and keeps a live snapshot per path: online state, tracks/resolution,
// smoothed inbound bitrate, readers, publisher address and SRT link quality.

const POLL_MS = 1000;
const TIMEOUT_MS = 1500;

async function getJson(base, p) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(base.replace(/\/$/, '') + p, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Inbound kbps from two byte counters; EMA-smoothed against the previous rate.
export function computeKbps(prevBytes, prevTs, bytes, ts, prevKbps = null) {
  if (prevBytes == null || prevTs == null || ts <= prevTs || bytes < prevBytes) return prevKbps ?? 0;
  const kbps = ((bytes - prevBytes) * 8) / (ts - prevTs); // bytes/ms*8 = kbit/s
  return prevKbps == null ? kbps : prevKbps * 0.6 + kbps * 0.4;
}

// Collapse MediaMTX's tracks2 into a short human description.
export function describeTracks(tracks2) {
  const out = { video: null, audio: null };
  for (const t of tracks2 ?? []) {
    const p = t.codecProps ?? {};
    if (!out.video && p.width) out.video = `${t.codec} ${p.width}x${p.height}`;
    else if (!out.audio && (p.sampleRate || /audio|opus|aac|mpeg-4 audio|g711|mp3/i.test(t.codec))) {
      out.audio = `${t.codec}${p.sampleRate ? ` ${Math.round(p.sampleRate / 1000)}k` : ''}${p.channelCount ? ` ${p.channelCount}ch` : ''}`;
    } else if (!out.video) out.video = t.codec;
  }
  return out;
}

export class MediaMtxMonitor {
  constructor(apiBase = process.env.MEDIAMTX_API || 'http://127.0.0.1:9997') {
    this.apiBase = apiBase;
    this.online = false;
    this.error = null;
    this.paths = new Map(); // name -> stats
    this._timer = null;
    this._busy = false;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), POLL_MS);
    this._tick();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async _tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      const [paths, rtmp, srt] = await Promise.all([
        getJson(this.apiBase, '/v3/paths/list?itemsPerPage=1000'),
        getJson(this.apiBase, '/v3/rtmpconns/list?itemsPerPage=1000').catch(() => ({ items: [] })),
        getJson(this.apiBase, '/v3/srtconns/list?itemsPerPage=1000').catch(() => ({ items: [] })),
      ]);
      const conns = new Map();
      for (const c of rtmp.items ?? []) conns.set(c.id, { protocol: 'RTMP', ...c });
      for (const c of srt.items ?? []) conns.set(c.id, { protocol: 'SRT', ...c });

      const now = Date.now();
      const next = new Map();
      for (const p of paths.items ?? []) {
        const prev = this.paths.get(p.name);
        const bytes = Number(p.bytesReceived ?? p.inboundBytes ?? 0);
        const src = p.source ? conns.get(p.source.id) : null;
        next.set(p.name, {
          name: p.name,
          online: !!(p.ready ?? p.online),
          since: p.readyTime ?? p.onlineTime ?? null,
          tracks: describeTracks(p.tracks2),
          readers: (p.readers ?? []).length,
          bytesReceived: bytes,
          kbps: computeKbps(prev?.bytesReceived, prev?._ts, bytes, now, prev?.kbps ?? null),
          sourceType: p.source?.type ?? null,
          publisher: src ? {
            protocol: src.protocol,
            remoteAddr: src.remoteAddr ?? null,
            rttMs: src.msRTT ?? null,
            lossPackets: src.packetsReceivedLoss ?? null,
          } : null,
          _ts: now,
        });
      }
      this.paths = next;
      this.online = true;
      this.error = null;
    } catch (err) {
      this.online = false;
      this.error = err.name === 'AbortError' ? 'timeout' : err.message;
    } finally {
      this._busy = false;
    }
  }

  get(name) {
    const s = this.paths.get(name);
    if (!s) return null;
    const { _ts, ...rest } = s;
    return rest;
  }
}
