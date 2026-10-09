/* Live Tools home: live ingest summary (when signed in) + tool tiles. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function fmtKbps(k) {
    if (k == null) return '—';
    return k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${Math.round(k)} kbps`;
  }
  function fmtUp(since) {
    if (!since) return '';
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  }

  function signedOut() {
    $('ingestSummary').textContent = 'sign in to see status';
    $('ingestSummary').className = 'pill off';
    $('liveGrid').innerHTML = `<div class="live-card empty-card">
      <p>Sign in to see which feeds are live.</p>
      <a class="btn" href="/admin?next=/">Sign in</a></div>`;
  }

  async function refresh() {
    let res;
    try { res = await fetch('/api/admin/ingests'); } catch { return; }
    if (res.status === 401) return signedOut();
    if (!res.ok) return;
    const data = await res.json();

    $('authBtn').textContent = 'Admin';
    $('authBtn').href = '/admin';
    $('ingestManage').classList.remove('hidden');

    const ing = data.ingests;
    const live = ing.filter((i) => i.live?.online);
    $('ingestSummary').textContent = data.mediamtx.online
      ? `${live.length} live · ${ing.length} configured`
      : 'MediaMTX offline';
    $('ingestSummary').className = 'pill ' + (data.mediamtx.online && live.length ? 'on' : 'off');
    $('tIngest').textContent = `${live.length} live / ${ing.length}`;

    if (!ing.length) {
      $('liveGrid').innerHTML = `<div class="live-card empty-card"><p>No ingests yet.</p>
        <a class="btn" href="/admin#ingest">Create a stream key</a></div>`;
      return;
    }
    // Live first, then by name.
    const sorted = ing.slice().sort((a, b) => (!!b.live?.online - !!a.live?.online) || a.name.localeCompare(b.name));
    $('liveGrid').innerHTML = sorted.map((i) => {
      const l = i.live;
      const on = !!l?.online;
      return `<a class="live-card ${on ? 'is-live' : ''}" href="/admin#ingest">
        <div class="lc-top"><span class="status-dot ${on ? 'ok' : 'offline'}"></span>
          <span class="lc-name">${esc(i.name)}</span>
          <span class="lc-state">${on ? 'LIVE' : (i.enabled ? 'waiting' : 'disabled')}</span></div>
        <div class="lc-big mono">${on ? fmtKbps(l.kbps) : '—'}</div>
        <div class="lc-sub">${on ? `${esc(l.tracks.video || '')}${l.tracks.audio ? ' · ' + esc(l.tracks.audio) : ''} · up ${fmtUp(l.since)}` : 'No signal'}</div>
      </a>`;
    }).join('');
  }

  async function streams() {
    try {
      const r = await fetch('/api/streams');
      if (!r.ok) return;
      const { streams: s } = await r.json();
      $('tStreams').textContent = `${s.length} stream${s.length === 1 ? '' : 's'}`;
    } catch {}
  }

  refresh();
  streams();
  setInterval(refresh, 2000);
})();
