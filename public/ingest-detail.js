/* Ingest detail page: polls /api/admin/ingests/:id/metrics once a second and
   renders hero stats, audio meters, charts, stream info, viewers and events. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const id = decodeURIComponent(location.pathname.replace(/^\/ingest\//, ''));

  // Validated (dataviz validator, dark surface #0A0A0C): series 1 cyan, series 2 fire.
  const C1 = '#0099D2';
  const C2 = '#EE2750';
  const NEUTRAL = '#B8B8BE';

  const kbps = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} M` : `${Math.round(v)} k`);
  const one = (v) => (v == null ? '—' : String(Math.round(v * 10) / 10));
  const int = (v) => (v == null ? '—' : String(Math.round(v)));
  const db = (v) => (v == null ? '−∞' : (Math.round(v * 10) / 10).toFixed(1));

  const charts = {
    bitrate: GFChart($('cBitrate'), { title: 'Bitrate (total in)', unit: 'bps', series: [{ key: 'kbps', label: 'Bitrate', color: C1 }], fmt: kbps }),
    fps: GFChart($('cFps'), { title: 'Frame rate', unit: 'fps', series: [{ key: 'fps', label: 'Frames', color: C1 }], fmt: int }),
    gap: GFChart($('cGap'), { title: 'Longest gap between frames', unit: 'ms', series: [{ key: 'maxIntMs', label: 'Max gap', color: C1 }], fmt: int }),
    late: GFChart($('cLate'), { title: 'Late / missing frames per second', unit: 'frames', type: 'bar', series: [{ key: 'late', label: 'Late', color: C2 }], fmt: int }),
    gop: GFChart($('cGop'), { title: 'Keyframe interval', unit: 's', series: [{ key: 'gop', label: 'GOP', color: C1 }], fmt: one }),
    audio: GFChart($('cAudio'), { title: 'Audio peak', unit: 'dBFS', min: -60, max: 0,
      series: [{ key: (p) => p.levels?.[0]?.peak, label: 'Ch 1', color: C1 }, { key: (p) => p.levels?.[1]?.peak, label: 'Ch 2', color: C2 }], fmt: one }),
    lufs: GFChart($('cLufs'), { title: 'Loudness (momentary)', unit: 'LUFS', min: -50, max: 0, series: [{ key: 'mLufs', label: 'Momentary', color: C1 }], fmt: one }),
    rtt: GFChart($('cRtt'), { title: 'Viewer SRT round-trip', unit: 'ms', series: [{ key: 'srtRttMs', label: 'RTT', color: C1 }], fmt: one }),
    loss: GFChart($('cLoss'), { title: 'Viewer SRT packets lost / resent', unit: 'pkts',
      series: [{ key: 'srtLoss', label: 'Lost', color: C2 }, { key: 'srtRetrans', label: 'Resent', color: C1 }], fmt: int }),
  };

  let points = [];
  let events = [];
  let last = 0;
  let windowMin = 15;
  let latest = null;

  document.querySelectorAll('#range button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b));
    windowMin = Number(b.dataset.m);
    render();
  }));

  function stat(label, value, sub, warn) {
    return `<div class="stat${warn ? ' warn' : ''}"><span class="s-label">${esc(label)}</span>
      <span class="s-value">${value}</span><span class="s-sub">${sub ? esc(sub) : ''}</span></div>`;
  }

  function fmtUp(since) {
    if (!since) return '';
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000));
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  }

  function renderMeters(p) {
    const levels = p?.levels || [];
    if (!levels.length) { $('meters').innerHTML = '<p class="muted">No audio data yet.</p>'; return; }
    $('meters').innerHTML = levels.map((l, i) => {
      const pct = (v) => (v == null ? 0 : Math.max(0, Math.min(100, ((v + 60) / 60) * 100)));
      const hot = l.peak != null && l.peak > -1;
      return `<div class="meter"><span class="m-label">Ch ${i + 1}</span>
        <div class="m-bar"><div class="m-rms" style="width:${pct(l.rms)}%"></div><div class="m-peak${hot ? ' hot' : ''}" style="left:${pct(l.peak)}%"></div></div>
        <span class="m-val mono">${db(l.peak)} pk · ${db(l.rms)} rms</span></div>`;
    }).join('') + '<div class="m-scale mono"><span>−60</span><span>−40</span><span>−20</span><span>0 dBFS</span></div>';
    $('loud').innerHTML = `<span>Momentary <b class="mono">${one(p.mLufs)}</b></span>
      <span>Short-term <b class="mono">${one(p.sLufs)}</b></span>
      <span>Integrated <b class="mono">${one(p.iLufs)}</b> LUFS</span>
      <span>Range <b class="mono">${one(p.lra)}</b> LU</span>`;
    $('silence').classList.toggle('hidden', !p.silent);
  }

  function renderInfo(d) {
    const v = d.info?.video; const a = d.info?.audio; const pub = d.live?.publisher;
    const rows = [
      ['Video', v ? `${v.codec?.toUpperCase()} ${v.profile || ''} L${v.level ?? ''}`.trim() : '—'],
      ['Resolution', v ? `${v.width}×${v.height}${v.fieldOrder && v.fieldOrder !== 'progressive' ? ' interlaced' : ''}` : '—'],
      ['Frame rate', v?.fps ? `${v.fps} fps` : '—'],
      ['Pixel format', v?.pixFmt || '—'],
      ['Colour space', v?.colorSpace || '—'],
      ['Audio', a ? `${a.codec?.toUpperCase()} ${a.profile || ''}`.trim() : '—'],
      ['Sample rate', a?.sampleRate ? `${a.sampleRate / 1000} kHz` : '—'],
      ['Channels', a ? `${a.channels}${a.layout ? ` (${a.layout})` : ''}` : '—'],
      ['Encoder', pub ? `${pub.protocol} from ${pub.remoteAddr || '?'}` : '—'],
      ['Encoder software', pub?.userAgent || '—'],
      ['Frames damaged', String(d.live?.framesInError ?? 0)],
      ['Late frames (session)', String(d.totals?.late ?? 0)],
      ['Silent seconds (session)', String(d.totals?.silenceSeconds ?? 0)],
    ];
    $('info').innerHTML = rows.map(([k, val]) => `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`).join('');
  }

  function renderViewers(d) {
    const list = (d.live?.readerList || []).filter((r) => !r.analyzer);
    if (!list.length) { $('viewers').innerHTML = '<p class="muted">Nobody is pulling this feed.</p>'; return; }
    $('viewers').innerHTML = `<table class="conn-table small"><thead><tr><th>Viewer</th><th>RTT</th><th>Send</th><th>Link</th><th>Lost</th><th>Resent</th><th>Dropped</th><th>Since</th></tr></thead><tbody>
      ${list.map((r) => `<tr><td class="mono">${esc(r.protocol)} ${esc(r.remoteAddr || '')}</td>
        <td class="mono">${r.rttMs != null ? one(r.rttMs) + ' ms' : '—'}</td>
        <td class="mono">${r.sendMbps != null ? one(r.sendMbps) + ' Mb/s' : '—'}</td>
        <td class="mono">${r.linkMbps != null ? int(r.linkMbps) + ' Mb/s' : '—'}</td>
        <td class="mono">${r.lossPackets ?? '—'}</td><td class="mono">${r.retransPackets ?? '—'}</td>
        <td class="mono">${r.dropPackets ?? r.framesDiscarded ?? '—'}</td>
        <td class="mono">${fmtUp(r.created)}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderEvents() {
    $('events').innerHTML = events.slice().reverse().slice(0, 200).map((e) =>
      `<li class="ev-${esc(e.type)}"><span class="mono">${new Date(e.t).toTimeString().slice(0, 8)}</span> ${esc(e.msg)}</li>`).join('')
      || '<li class="muted">No events yet.</li>';
  }

  function render() {
    const win = windowMin * 60 * 1000;
    for (const c of Object.values(charts)) c.update(points, win);
  }

  async function poll() {
    let res;
    try { res = await fetch(`/api/admin/ingests/${encodeURIComponent(id)}/metrics?since=${last}`); } catch { return; }
    if (res.status === 401) {
      $('signin').classList.remove('hidden');
      $('signinBtn').href = '/admin?next=' + encodeURIComponent(location.pathname);
      return;
    }
    if (!res.ok) { $('dName').textContent = 'Ingest not found'; return; }
    const d = await res.json();
    latest = d;
    $('signin').classList.add('hidden');
    document.title = `${d.ingest.name} · GlassFire Live Tools`;
    $('dName').textContent = d.ingest.name;
    const on = !!d.live?.online;
    $('dState').textContent = on ? 'LIVE' : (d.ingest.enabled ? 'waiting' : 'disabled');
    $('dState').className = 'pill ' + (on ? 'on' : 'off');
    $('dUp').textContent = on ? `up ${fmtUp(d.live.since)}` : '';

    if (d.series.length) {
      points = points.concat(d.series).slice(-7200);
      last = points[points.length - 1].t;
    }
    if (d.events.length) events = events.concat(d.events).slice(-500);

    const p = on ? points[points.length - 1] : null;
    const v = d.info?.video;
    $('stats').innerHTML = [
      stat('Bitrate', on ? kbps(d.live.kbps) + 'bps' : '—', p?.videoKbps != null ? `video ${kbps(p.videoKbps)}bps` : ''),
      stat('Frame rate', p ? int(p.fps) : '—', v?.fps ? `of ${v.fps} expected` : '', p && v?.fps && p.fps < v.fps * 0.9),
      stat('Resolution', v ? `${v.width}×${v.height}` : '—', v ? `${v.codec?.toUpperCase()} ${v.profile || ''}` : ''),
      stat('Keyframes', p?.gop != null ? `${one(p.gop)} s` : '—', 'interval', p?.gop > 4),
      stat('Late frames', String(d.totals?.late ?? 0), 'this session', (d.totals?.late ?? 0) > 0),
      stat('Loudness', p?.iLufs != null ? `${one(p.iLufs)}` : '—', 'LUFS integrated'),
      stat('Viewers', String(d.live?.readers ?? 0), (d.live?.readerList || []).filter((r) => !r.analyzer).map((r) => r.protocol).join(', ')),
      stat('Damaged frames', String(d.live?.framesInError ?? 0), 'from encoder', (d.live?.framesInError ?? 0) > 0),
    ].join('');

    renderMeters(p);
    renderInfo(d);
    renderViewers(d);
    renderEvents();
    render();
  }

  $('csvBtn').addEventListener('click', () => {
    const cols = ['t', 'kbps', 'videoKbps', 'fps', 'maxIntMs', 'late', 'keys', 'gop', 'mLufs', 'sLufs', 'iLufs', 'lra', 'silent', 'errors', 'viewers', 'srtRttMs', 'srtLoss', 'srtRetrans'];
    const nCh = Math.max(0, ...points.map((p) => p.levels?.length || 0));
    const head = cols.concat(Array.from({ length: nCh }, (_, i) => [`ch${i + 1}PeakDb`, `ch${i + 1}RmsDb`]).flat());
    const lines = [head.join(',')].concat(points.map((p) => cols.map((c) => (c === 't' ? new Date(p.t).toISOString() : p[c] ?? ''))
      .concat(Array.from({ length: nCh }, (_, i) => [p.levels?.[i]?.peak ?? '', p.levels?.[i]?.rms ?? '']).flat()).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${latest?.ingest?.name || 'ingest'}-metrics.csv`;
    a.click();
  });

  poll();
  setInterval(poll, 1000);
})();
