// Stream analyzer.
//
// For every live MediaMTX path, attaches two lightweight readers over loopback
// RTSP and turns what they see into a per-second time series + an event log:
//   - ffprobe: video packet timing WITHOUT decoding pictures (fps, frame
//     interval jitter, late/dropped frames, keyframe spacing, video bitrate).
//   - ffmpeg:  decodes audio only (cheap) for per-channel peak/RMS every 100ms
//     and EBU R128 loudness (momentary / short-term / integrated).
// Plus stream info from a one-shot ffprobe (codec, profile, level, fps, pixel
// format, sample rate, channel layout).
//
// History is in memory: ~2h at 1s per path, survives publisher reconnects.

import { spawn } from 'child_process';

const HISTORY_SECONDS = 2 * 60 * 60;
const MAX_EVENTS = 500;
const SILENCE_DB = -60;
const SILENCE_SECONDS = 5;

const FFPROBE = process.env.FFPROBE || 'ffprobe';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
// Read over loopback RTMP: it carries the encoder's real DTS (over RTSP the
// reader re-derives DTS, which invents backwards jumps with B-frames).
const SOURCE_BASE = process.env.ANALYZER_SOURCE || 'rtmp://127.0.0.1:1935';
const WARMUP_SECONDS = 3;

// ---- pure parsers (unit tested) --------------------------------------------

// "pts,dts,duration,size,flags" from ffprobe -show_entries packet=… -of csv=p=0
export function parsePacketLine(line) {
  const [pts, dts, dur, size, flags] = line.trim().split(',');
  const d = Number(dts !== 'N/A' && dts !== '' ? dts : pts);
  if (!Number.isFinite(d)) return null;
  return { dts: d, size: Number(size) || 0, key: (flags || '').startsWith('K'), dur: Number(dur) || null };
}

const EBU_RE = /M:\s*(-?[\d.]+|-?inf)\s+S:\s*(-?[\d.]+|-?inf)\s+I:\s*(-?[\d.]+|-?inf)\s+LUFS\s+LRA:\s*(-?[\d.]+)/;
const ASTATS_RE = /lavfi\.astats\.(\d+)\.(Peak_level|RMS_level)=(-?[\d.]+|-?inf)/;
const num = (s) => (/inf/.test(s) ? -Infinity : Number(s));

// One stderr line from the audio ffmpeg → a parsed record, or null.
export function parseAudioLine(line) {
  let m = ASTATS_RE.exec(line);
  if (m) return { kind: 'level', ch: Number(m[1]), stat: m[2] === 'Peak_level' ? 'peak' : 'rms', db: num(m[3]) };
  m = EBU_RE.exec(line);
  if (m) return { kind: 'loudness', m: num(m[1]), s: num(m[2]), i: num(m[3]), lra: Number(m[4]) };
  return null;
}

// Fold one second of packets into video stats. `nominalMs` is the expected
// frame interval; a gap > 1.5x nominal counts as a late/missing frame.
export function summarizeVideo(packets, nominalMs) {
  const out = { frames: packets.length, bytes: 0, keys: 0, maxIntMs: 0, late: 0, backwards: 0 };
  for (let i = 0; i < packets.length; i += 1) {
    const p = packets[i];
    out.bytes += p.size;
    if (p.key) out.keys += 1;
    if (i > 0) {
      const gap = (p.dts - packets[i - 1].dts) * 1000;
      if (gap < 0) out.backwards += 1;
      else {
        if (gap > out.maxIntMs) out.maxIntMs = gap;
        if (nominalMs && gap > nominalMs * 1.5) out.late += Math.max(1, Math.round(gap / nominalMs) - 1);
      }
    }
  }
  return out;
}

const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

// ---- per-path session ---------------------------------------------------------

class PathAnalyzer {
  constructor(name, onEvent, getLive) {
    this.name = name;
    this.onEvent = onEvent;
    this.getLive = getLive;
    this._lastErr = null;
    this._lastLoss = new Map();
    this.series = [];
    this.info = null;
    this.totals = { late: 0, backwards: 0, frames: 0, silenceSeconds: 0 };
    this.procs = [];
    this.running = false;
    this._pkts = [];
    this._lastPkt = null;
    this._lastKeyDts = null;
    this._gops = [];
    this._intervals = [];
    this._levels = new Map(); // ch -> {peak, rms} max over the current second
    this._loud = null;
    this._silentFor = 0;
    this._timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._ticks = 0;
    this._probeInfo();
    this._spawnVideo();
    this._spawnAudio();
    this._timer = setInterval(() => this._tick(), 1000);
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
    for (const p of this.procs) p.kill('SIGKILL');
    this.procs = [];
  }

  _url() { return `${SOURCE_BASE}/${this.name}`; }

  _spawn(cmd, args, onLine, stream = 'stdout', label) {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.procs.push(p);
    let buf = '';
    p[stream].on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(line);
      }
    });
    if (stream === 'stdout') p.stderr.resume();
    p.on('error', (e) => this.onEvent('analyzer', `${label} failed to start: ${e.message}`));
    p.on('exit', () => {
      this.procs = this.procs.filter((x) => x !== p);
      // Restart while the path is still live (e.g. a hiccup on the RTSP read).
      if (this.running) setTimeout(() => this.running && (label === 'video' ? this._spawnVideo() : this._spawnAudio()), 2000);
    });
    return p;
  }

  _probeInfo() {
    const p = spawn(FFPROBE, ['-v', 'error', '-i', this._url(),
      '-show_streams', '-of', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => {
      try {
        const s = JSON.parse(out).streams || [];
        const v = s.find((x) => x.codec_type === 'video');
        const a = s.find((x) => x.codec_type === 'audio');
        const fps = (r) => { const [n, d] = String(r || '').split('/').map(Number); return d ? Math.round((n / d) * 100) / 100 : null; };
        const next = {
          video: v ? { codec: v.codec_name, profile: v.profile, level: v.level, width: v.width, height: v.height,
            pixFmt: v.pix_fmt, fps: fps(v.avg_frame_rate) || fps(v.r_frame_rate), colorSpace: v.color_space || null,
            fieldOrder: v.field_order || null } : null,
          audio: a ? { codec: a.codec_name, profile: a.profile, sampleRate: Number(a.sample_rate), channels: a.channels,
            layout: a.channel_layout, sampleFmt: a.sample_fmt } : null,
        };
        if (this.info && JSON.stringify(this.info) !== JSON.stringify(next)) this.onEvent('format', 'Stream format changed');
        this.info = next;
      } catch { /* stream may not be readable yet; retried on reconnect */ }
    });
  }

  _spawnVideo() {
    this._spawn(FFPROBE, ['-v', 'error', '-i', this._url(), '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,dts_time,duration_time,size,flags', '-of', 'csv=p=0'],
    (line) => {
      const p = parsePacketLine(line);
      if (!p) return;
      if (this._lastPkt) {
        const gap = (p.dts - this._lastPkt.dts) * 1000;
        if (gap > 0 && gap < 1000) { this._intervals.push(gap); if (this._intervals.length > 120) this._intervals.shift(); }
      }
      if (p.key) {
        if (this._lastKeyDts != null) this._gops.push(p.dts - this._lastKeyDts);
        this._lastKeyDts = p.dts;
      }
      this._lastPkt = p;
      this._pkts.push(p);
    }, 'stdout', 'video');
  }

  _spawnAudio() {
    const af = 'asetnsamples=n=4800:p=0,astats=metadata=1:reset=1:measure_perchannel=Peak_level+RMS_level:measure_overall=none,'
      + 'ametadata=mode=print,ebur128=framelog=verbose';
    this._spawn(FFMPEG, ['-nostdin', '-hide_banner', '-nostats', '-loglevel', 'verbose',
      '-i', this._url(), '-map', '0:a:0', '-af', af, '-f', 'null', '-'],
    (line) => {
      const r = parseAudioLine(line);
      if (!r) return;
      if (r.kind === 'level') {
        const cur = this._levels.get(r.ch) || { peak: -Infinity, rms: -Infinity };
        if (r.db > cur[r.stat]) cur[r.stat] = r.db;
        this._levels.set(r.ch, cur);
      } else {
        this._loud = r;
      }
    }, 'stderr', 'audio');
  }

  _nominalMs() {
    if (this.info?.video?.fps) return 1000 / this.info.video.fps;
    if (!this._intervals.length) return null;
    const s = [...this._intervals].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  _tick() {
    const pkts = this._pkts;
    this._pkts = [];
    const v = summarizeVideo(pkts, this._nominalMs());
    const levels = [...this._levels.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => ({ peak: r1(l.peak), rms: r1(l.rms) }));
    this._levels = new Map();
    const gop = this._gops.length ? this._gops[this._gops.length - 1] : null;

    const silent = levels.length > 0 && levels.every((l) => l.peak == null || l.peak < SILENCE_DB);
    if (silent) {
      this._silentFor += 1;
      this.totals.silenceSeconds += 1;
      if (this._silentFor === SILENCE_SECONDS) this.onEvent('silence', `Audio silent for ${SILENCE_SECONDS}s`);
    } else {
      if (this._silentFor >= SILENCE_SECONDS) this.onEvent('audio', `Audio back after ${this._silentFor}s of silence`);
      this._silentFor = 0;
    }
    // Connect bursts deliver a buffered GOP at once; don't alarm on them.
    this._ticks = (this._ticks || 0) + 1;
    if (this._ticks <= WARMUP_SECONDS) { v.late = 0; v.backwards = 0; }
    if (v.late >= 5) this.onEvent('frames', `${v.late} late/missing frames in one second (max gap ${Math.round(v.maxIntMs)} ms)`);
    if (v.backwards) this.onEvent('timestamps', `${v.backwards} timestamp jump(s) backwards`);
    if (pkts.length === 0 && this.series.length && this.series[this.series.length - 1].fps > 0) {
      this.onEvent('frames', 'Video stopped arriving');
    }

    this.totals.late += v.late;
    this.totals.backwards += v.backwards;
    this.totals.frames += v.frames;

    // Server-side view of the same second (MediaMTX counters + viewer links).
    const live = this.getLive();
    const errNow = live?.framesInError ?? null;
    const errDelta = errNow != null && this._lastErr != null ? Math.max(0, errNow - this._lastErr) : 0;
    this._lastErr = errNow;
    if (errDelta > 0) this.onEvent('errors', `${errDelta} frame(s) arrived damaged`);
    const viewers = (live?.readerList || []).filter((r) => !r.analyzer);
    let rtt = null; let loss = 0; let retrans = 0;
    for (const r of viewers) {
      if (r.rttMs != null) rtt = Math.max(rtt ?? 0, r.rttMs);
      const prev = this._lastLoss.get(r.id) || { loss: r.lossPackets || 0, retrans: r.retransPackets || 0 };
      loss += Math.max(0, (r.lossPackets || 0) - prev.loss);
      retrans += Math.max(0, (r.retransPackets || 0) - prev.retrans);
      this._lastLoss.set(r.id, { loss: r.lossPackets || 0, retrans: r.retransPackets || 0 });
    }

    this.series.push({
      t: Date.now(),
      kbps: live ? Math.round(live.kbps) : null,
      errors: errDelta,
      viewers: viewers.length,
      srtRttMs: rtt != null ? r1(rtt) : null,
      srtLoss: loss,
      srtRetrans: retrans,
      fps: v.frames,
      videoKbps: Math.round((v.bytes * 8) / 1000),
      maxIntMs: Math.round(v.maxIntMs),
      late: v.late,
      keys: v.keys,
      gop: gop != null ? Math.round(gop * 100) / 100 : null,
      levels,
      mLufs: this._loud ? r1(this._loud.m) : null,
      sLufs: this._loud ? r1(this._loud.s) : null,
      iLufs: this._loud ? r1(this._loud.i) : null,
      lra: this._loud ? this._loud.lra : null,
      silent,
    });
    if (this.series.length > HISTORY_SECONDS) this.series.shift();
  }
}

// ---- manager ----------------------------------------------------------------------

export class StreamAnalyzer {
  constructor(monitor) {
    this.monitor = monitor;
    this.paths = new Map(); // name -> PathAnalyzer (kept after going offline for history)
    this.events = new Map(); // name -> [{t,type,msg}]
    this._wasOnline = new Map();
    this._timer = null;
  }

  start() {
    this._timer = setInterval(() => this._sync(), 1000);
  }

  stop() {
    clearInterval(this._timer);
    for (const a of this.paths.values()) a.stop();
  }

  event(name, type, msg) {
    const list = this.events.get(name) || [];
    list.push({ t: Date.now(), type, msg });
    if (list.length > MAX_EVENTS) list.shift();
    this.events.set(name, list);
  }

  _sync() {
    if (!this.monitor.online) return;
    const seen = new Set();
    for (const [name, st] of this.monitor.paths) {
      seen.add(name);
      const was = this._wasOnline.get(name) || false;
      if (st.online && !was) {
        const pub = st.publisher ? ` from ${st.publisher.protocol} ${st.publisher.remoteAddr || ''}` : '';
        this.event(name, 'connect', `Publisher connected${pub}`);
        let a = this.paths.get(name);
        if (!a) {
          a = new PathAnalyzer(name, (type, msg) => this.event(name, type, msg), () => this.monitor.get(name));
          this.paths.set(name, a);
        }
        a.start();
      }
      if (!st.online && was) this._offline(name);
      this._wasOnline.set(name, st.online);
    }
    for (const [name, was] of this._wasOnline) {
      if (was && !seen.has(name)) { this._offline(name); this._wasOnline.set(name, false); }
    }
  }

  _offline(name) {
    this.event(name, 'disconnect', 'Publisher disconnected');
    this.paths.get(name)?.stop();
  }

  get(name) { return this.paths.get(name) || null; }
}
