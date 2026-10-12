/* vMix overview: per machine state, outputs, inputs with live audio meters, buses. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (db) => (db == null ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100)));
  const dbText = (db) => (db == null ? '−∞' : db.toFixed(0));
  const clock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
  };

  function meter(db, label) {
    const hot = db != null && db > -1;
    return `<div class="vm-meter" title="${label ? esc(label) + ' ' : ''}${dbText(db)} dB"><div class="vm-fill${hot ? ' hot' : ''}" style="width:${pct(db)}%"></div></div>`;
  }
  function stereo(db, muted) {
    return `<div class="vm-stereo${muted ? ' muted' : ''}">${meter(db?.[0], 'L')}${meter(db?.[1], 'R')}</div>
      <span class="mono small vm-db">${muted ? 'muted' : `${dbText(db?.[0])} / ${dbText(db?.[1])}`}</span>`;
  }
  const badge = (on, text, cls = 'on') => `<span class="pill ${on ? cls : 'off'}">${text}</span>`;

  function machine(m) {
    const s = m.status;
    if (!s?.reachable) {
      return `<section class="panel"><div class="section-head"><span class="status-dot offline"></span><h2 style="margin:0">${esc(m.label)}</h2>
        <span class="muted small">${esc(m.host)} · ${esc(s?.error || 'connecting')}</span></div></section>`;
    }
    const inputs = s.inputs || [];
    const title = (n) => inputs.find((i) => i.number === n)?.title || (n ? `Input ${n}` : '—');
    const outs = (s.outputs || []).filter((o) => o.type === 'output' || o.ndi || o.srt).map((o) =>
      `<li>Output ${o.number}: ${o.source === 'Input' ? `input ${o.input} (${esc(title(o.input))})` : esc(o.source || 'Program')}${o.ndi ? ' · NDI' : ''}${o.srt ? ' · SRT' : ''}</li>`).join('');
    const buses = Object.entries(s.buses || {}).map(([b, v]) => `<div class="vm-bus"><span class="mono">Bus ${b}</span>${stereo(v.db, v.muted)}</div>`).join('');
    return `<section class="panel">
      <div class="section-head"><span class="status-dot ok"></span><h2 style="margin:0">${esc(m.label)}</h2>
        <span class="muted small">vMix ${esc(s.version)} ${esc(s.edition)}${s.preset ? ` · ${esc(s.preset)}` : ''}</span><div class="spacer"></div>
        ${badge(s.streaming, s.streaming ? `STREAMING${s.streamChannels?.length ? ` ch ${s.streamChannels.join(', ')}` : ''}` : 'not streaming', 'live')}
        ${badge(s.recording, s.recording ? 'REC' : 'not recording', 'live')}
        ${badge(s.external, 'EXTERNAL')}${badge(s.multiCorder, 'MULTICORDER')}${s.fadeToBlack ? badge(true, 'FADE TO BLACK', 'warn') : ''}
      </div>
      <div class="vm-top">
        <div class="vm-pgm"><span class="s-label">Program</span><b>${esc(title(s.active))}</b></div>
        <div class="vm-pvw"><span class="s-label">Preview</span><b>${esc(title(s.preview))}</b></div>
        <div class="vm-master"><span class="s-label">Master</span>${stereo(s.masterDb, s.masterMuted)}</div>
      </div>
      ${outs ? `<ul class="vm-outs small">${outs}</ul>` : ''}
      <table class="conn-table vm-inputs"><thead><tr><th>#</th><th>Input</th><th>Type</th><th>State</th><th>Time</th><th>Audio</th><th>Buses</th></tr></thead><tbody>
        ${inputs.map((i) => `<tr class="${i.number === s.active ? 'vm-is-pgm' : i.number === s.preview ? 'vm-is-pvw' : ''}">
          <td class="mono">${i.number}</td>
          <td>${esc(i.title)}${i.number === s.active ? ' <span class="pill live">PGM</span>' : i.number === s.preview ? ' <span class="pill warn">PVW</span>' : ''}</td>
          <td class="small">${esc(i.type)}</td><td class="small">${esc(i.state || '')}</td>
          <td class="mono small">${i.durationMs ? `${clock(i.positionMs)} / ${clock(i.durationMs)}` : ''}</td>
          <td>${i.hasAudio ? stereo(i.db, i.muted) : '<span class="muted small">no audio</span>'}</td>
          <td class="mono small">${esc(i.buses || '')}</td></tr>`).join('')}
      </tbody></table>
      ${buses ? `<h3 class="subhead">Buses</h3><div class="vm-buses">${buses}</div>` : ''}
    </section>`;
  }

  async function poll() {
    try {
      const res = await fetch('/api/admin/vmix');
      if (res.status === 401) { $('signin').classList.remove('hidden'); return; }
      const { machines } = await res.json();
      $('signin').classList.add('hidden');
      $('machines').innerHTML = machines.length ? machines.map(machine).join('')
        : '<p class="muted">No vMix machines added yet. Add them on the <a href="/guests">Guests</a> page (vMix machines).</p>';
    } catch { /* retry next tick */ }
  }
  poll();
  setInterval(poll, 1000);
})();
