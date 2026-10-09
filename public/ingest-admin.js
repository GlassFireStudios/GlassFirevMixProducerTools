/* Ingest panel: stream keys + live MediaMTX stats. Plain browser script. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function api(path, opts = {}) {
    const res = await fetch('/api/admin' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  function fmtKbps(k) {
    if (k == null) return '—';
    return k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${Math.round(k)} kbps`;
  }
  function fmtUp(since) {
    if (!since) return '—';
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  }

  let cache = [];
  let openId = null;

  async function refresh() {
    if ($('app').classList.contains('hidden')) return;
    let data;
    try { data = await api('/ingests'); } catch { return; }
    cache = data.ingests;

    const pill = $('mtxPill');
    pill.textContent = data.mediamtx.online ? 'MediaMTX online' : `MediaMTX offline${data.mediamtx.error ? ' · ' + data.mediamtx.error : ''}`;
    pill.className = 'pill ' + (data.mediamtx.online ? 'on' : 'off');

    $('ingestEmpty').classList.toggle('hidden', cache.length > 0);
    $('ingestRows').replaceChildren(...cache.map(row));

    const other = (data.otherPaths || []).filter(Boolean);
    $('otherPaths').innerHTML = other.length ? `
      <h3 class="subhead">Other live paths <span class="muted">(pushed with legacy credentials)</span></h3>
      <table class="conn-table"><tbody>${other.map((p) => `
        <tr><td><span class="status-dot ${p.online ? 'ok' : 'offline'}"></span></td>
          <td class="mono">${esc(p.name)}</td><td>${esc(p.tracks.video || '—')}</td><td>${esc(p.tracks.audio || '—')}</td>
          <td class="mono">${fmtKbps(p.kbps)}</td><td class="mono">${fmtUp(p.since)}</td><td>${p.readers}</td>
          <td class="mono">${esc(p.publisher?.remoteAddr || '—')}</td>
          <td><button class="btn small secondary" data-copy="read:${esc(p.name)}">copy SRT stream ID</button></td></tr>`).join('')}
      </tbody></table>` : '';
    $('otherPaths').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b)));

    if (openId) {
      const rec = cache.find((i) => i.id === openId);
      if (rec) renderStatusLine(rec);
    }
  }

  function row(i) {
    const tr = document.createElement('tr');
    const live = i.live;
    const on = !!live?.online;
    tr.innerHTML = `
      <td><span class="status-dot ${on ? 'ok' : 'offline'}" title="${on ? 'live' : 'waiting for stream'}"></span> ${on ? '<b>LIVE</b>' : '<span class="muted">waiting</span>'}</td>
      <td>${esc(i.name)}</td>
      <td>${esc(live?.tracks?.video || '—')}</td>
      <td>${esc(live?.tracks?.audio || '—')}</td>
      <td class="mono">${on ? fmtKbps(live.kbps) : '—'}</td>
      <td class="mono">${on ? fmtUp(live.since) : '—'}</td>
      <td>${live ? live.readers : 0}</td>
      <td class="mono">${esc(live?.publisher ? `${live.publisher.protocol} ${live.publisher.remoteAddr || ''}` : '—')}</td>
      <td><span class="pill ${i.enabled ? 'on' : 'off'}" data-act="toggle" style="cursor:pointer">${i.enabled ? 'enabled' : 'disabled'}</span></td>
      <td><div class="actions">
        <button class="btn small" data-act="setup">Setup</button>
        <button class="btn small secondary" data-act="regen">New key</button>
        <button class="btn small danger" data-act="del">Delete</button>
      </div></td>`;
    tr.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => act(el.dataset.act, i)));
    return tr;
  }

  async function act(a, i) {
    if (a === 'toggle') {
      await api(`/ingests/${i.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !i.enabled }) });
    } else if (a === 'regen') {
      if (!confirm(`Make a new key for “${i.name}”?\n\nThe old key stops working for NEW connections immediately. Update the encoder and the vMix input afterwards.`)) return;
      await api(`/ingests/${i.id}/regenerate`, { method: 'POST' });
      openSetup(i.id);
    } else if (a === 'del') {
      if (!confirm(`Delete “${i.name}” and its stream key?`)) return;
      await api(`/ingests/${i.id}`, { method: 'DELETE' });
    } else if (a === 'setup') {
      openSetup(i.id);
    }
    refresh();
  }

  function copy(text, btn) {
    navigator.clipboard?.writeText(text);
    if (btn) { const t = btn.textContent; btn.textContent = 'copied'; setTimeout(() => (btn.textContent = t), 1200); }
  }

  function field(label, value, secret) {
    return `<div class="kv"><span class="k">${esc(label)}</span>
      <code class="v${secret ? ' secret' : ''}">${esc(value)}</code>
      <button class="btn small secondary" data-copy="${esc(value)}">copy</button></div>`;
  }

  async function openSetup(id) {
    await refresh();
    const i = cache.find((x) => x.id === id);
    if (!i) return;
    openId = id;
    const s = i.setup;
    $('imTitle').textContent = i.name;
    $('imBody').innerHTML = `
      <div id="imStatus" class="im-status"></div>
      <h4>1 · In your RTMP encoder</h4>
      <p class="muted">Use a custom RTMP destination.</p>
      ${field('Stream URL', s.publisher.rtmpServer)}
      ${field('Stream key', s.publisher.streamKey, true)}
      <h4>2 · In vMix (any machine in the Broadcast group)</h4>
      <p class="muted">Add Input → Stream / SRT → Stream Type <b>SRT (Caller)</b></p>
      ${field('Hostname', s.vmixSrt.host)}
      ${field('Port', String(s.vmixSrt.port))}
      ${field('Stream ID', s.vmixSrt.streamId)}
      ${field('Latency (ms)', String(s.vmixSrt.latencyMs))}
      <details><summary class="muted">Prefer RTMP in vMix? (needs VLC for vMix)</summary>${field('URL', s.vmixRtmpUrl)}</details>
      <p class="muted small">The stream key is a password. Anyone with it can push video into this input. Use “New key” to revoke it.</p>`;
    $('imBody').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b)));
    renderStatusLine(i);
    $('ingestModal').classList.remove('hidden');
  }

  function renderStatusLine(i) {
    const el = $('imStatus');
    if (!el) return;
    const live = i.live;
    el.innerHTML = live?.online
      ? `<span class="status-dot ok"></span> <b>LIVE</b> · ${esc(live.tracks.video || '')} ${live.tracks.audio ? '· ' + esc(live.tracks.audio) : ''} · ${fmtKbps(live.kbps)} · up ${fmtUp(live.since)}`
      : `<span class="status-dot offline"></span> Waiting for the stream. Start streaming from the encoder and this turns green.`;
  }

  function closeModal() { openId = null; $('ingestModal').classList.add('hidden'); }
  $('imClose').addEventListener('click', closeModal);
  $('ingestModal').addEventListener('click', (e) => { if (e.target === $('ingestModal')) closeModal(); });

  $('ingestAddBtn').addEventListener('click', async () => {
    const name = prompt('Name this ingest (e.g. “Riverside – Episode 12”)');
    if (!name || !name.trim()) return;
    const { ingest } = await api('/ingests', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    openSetup(ingest.id);
  });

  setInterval(refresh, 1500);
  refresh();
})();
