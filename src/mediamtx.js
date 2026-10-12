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

// One reader of a path, with whatever link stats its protocol exposes.
export function describeReader(c, type) {
  if (!c) return { protocol: type || '?', remoteAddr: null, analyzer: false };
  const ip = String(c.remoteAddr || '').replace(/:\d+$/, '');
  const out = {
    id: c.id,
    protocol: c.protocol,
    remoteAddr: c.remoteAddr ?? null,
    created: c.created ?? null,
    // The hub's analyzer is the only thing that reads over loopback.
    analyzer: ip === '127.0.0.1' || ip === '[::1]',
    bytesSent: c.bytesSent ?? c.outboundBytes ?? null,
    framesDiscarded: c.outboundFramesDiscarded ?? null,
  };
  if (c.protocol === 'SRT') {
    Object.assign(out, {
      rttMs: c.msRTT ?? null,
      sendMbps: c.mbpsSendRate ?? null,
      linkMbps: c.mbpsLinkCapacity ?? null,
      lossPackets: c.packetsSendLoss ?? null,
      lossRate: c.packetsSendLossRate ?? null,
      retransPackets: c.packetsRetrans ?? null,
      dropPackets: c.packetsSendDrop ?? null,
      sendBufMs: c.msSendBuf ?? null,
    });
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
      const [paths, rtmp, srt, rtsp] = await Promise.all([
        getJson(this.apiBase, '/v3/paths/list?itemsPerPage=1000'),
        getJson(this.apiBase, '/v3/rtmpconns/list?itemsPerPage=1000').catch(() => ({ items: [] })),
        getJson(this.apiBase, '/v3/srtconns/list?itemsPerPage=1000').catch(() => ({ items: [] })),
        getJson(this.apiBase, '/v3/rtspsessions/list?itemsPerPage=1000').catch(() => ({ items: [] })),
      ]);
      const conns = new Map();
      for (const c of rtmp.items ?? []) conns.set(c.id, { protocol: 'RTMP', ...c });
      for (const c of srt.items ?? []) conns.set(c.id, { protocol: 'SRT', ...c });
      for (const c of rtsp.items ?? []) conns.set(c.id, { protocol: 'RTSP', ...c });

      const now = Date.now();
      const next = new Map();
      for (const p of paths.items ?? []) {
        const prev = this.paths.get(p.name);
        const bytes = Number(p.bytesReceived ?? p.inboundBytes ?? 0);
        const src = p.source ? conns.get(p.source.id) : null;
        const readerList = (p.readers ?? []).map((r) => describeReader(conns.get(r.id), r.type));
        next.set(p.name, {
          name: p.name,
          online: !!(p.ready ?? p.online),
          since: p.readyTime ?? p.onlineTime ?? null,
          tracks: describeTracks(p.tracks2),
          tracks2: p.tracks2 ?? [],
          framesInError: p.inboundFramesInError ?? 0,
          // The hub's own analyzer reads over loopback RTSP; don't count it as a viewer.
          readers: readerList.filter((r) => !r.analyzer).length,
          readerList,
          bytesReceived: bytes,
          kbps: computeKbps(prev?.bytesReceived, prev?._ts, bytes, now, prev?.kbps ?? null),
          sourceType: p.source?.type ?? null,
          publisher: src ? {
            protocol: src.protocol,
            remoteAddr: src.remoteAddr ?? null,
            userAgent: src.userAgent ?? null,
            created: src.created ?? null,
            rttMs: src.msRTT ?? null,
            lossPackets: src.packetsReceivedLoss ?? null,
            dropPackets: src.packetsReceivedDrop ?? null,
            retransPackets: src.packetsReceivedRetrans ?? null,
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
