/* Network page: FusionHub live SpeedFusion graphs (per peer, per WAN link). */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Validated series colours (dark surface): series 1 cyan, series 2 fire.
  const C1 = '#0099D2';
  const C2 = '#EE2750';
  const WINDOW = 15 * 60 * 1000;

  const series = new Map(); // key -> points[]
  const charts = new Map(); // key -> {rtt, tput, loss}
  let since = 0;

  async function api(p, opts = {}) {
    const res = await fetch('/api/admin' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  function ensureWan(container, key, title) {
    if (charts.has(key)) return charts.get(key);
    const box = document.createElement('div');
    box.className = 'fh-wan';
    box.innerHTML = `<h3 class="subhead">${esc(title)}</h3><div class="charts"><div></div><div></div><div></div></div>`;
    container.appendChild(box);
    const [a, b, c] = box.querySelectorAll('.charts > div');
    const set = {
      rtt: GFChart(a, { title: 'Round-trip time', unit: 'ms', series: [{ key: 'rttMs', label: 'RTT', color: C1 }] }),
      tput: GFChart(b, { title: 'Throughput', unit: 'Mbps', series: [{ key: 'rxMbps', label: 'In', color: C1 }, { key: 'txMbps', label: 'Out', color: C2 }] }),
      loss: GFChart(c, { title: 'Packets lost per second', unit: 'pkts/s', type: 'bar', series: [{ key: 'lossPerSec', label: 'Lost', color: C2 }] }),
    };
    charts.set(key, set);
    return set;
  }

  function render(v) {
    $('fhSetup').classList.toggle('hidden', v.config.configured);
    $('fhErr').classList.toggle('hidden', !v.error);
    $('fhErr').textContent = v.error || '';
    $('fhAt').textContent = v.at ? `updated ${new Date(v.at).toLocaleTimeString()}` : '';
    const root = $('fhPeers');
    if (!v.config.configured) { root.innerHTML = ''; return; }
    if (!v.peers.length) {
      root.innerHTML = '<p class="muted">No SpeedFusion peers connected right now. Graphs appear as soon as a field unit (e.g. GFBR2MAX Alpha) connects.</p>';
      charts.clear(); series.clear();
      return;
    }
    if (root.querySelector('p.muted')) root.innerHTML = '';
    for (const p of v.peers) {
      let pbox = root.querySelector(`[data-peer="${CSS.escape(p.id)}"]`);
      if (!pbox) {
        pbox = document.createElement('div');
        pbox.dataset.peer = p.id;
        pbox.className = 'fh-peer';
        root.appendChild(pbox);
      }
      if (!pbox.querySelector('.fh-peer-head')) pbox.insertAdjacentHTML('afterbegin', '<div class="section-head fh-peer-head"></div>');
      pbox.querySelector('.fh-peer-head').innerHTML = `<span class="status-dot ${/connected|established|up/i.test(p.state || '') ? 'ok' : ''}"></span>
        <b>${esc(p.name)}</b><span class="muted small">${esc(p.state || '')}</span><div class="spacer"></div>
        <span class="muted small">${p.wans.map((w) => `${esc(w.name)}: ${w.rttMs ?? '—'} ms, ${w.rxMbps != null ? w.rxMbps.toFixed(1) : '—'}/${w.txMbps != null ? w.txMbps.toFixed(1) : '—'} Mbps`).join(' · ')}</span>`;
      for (const w of p.wans) {
        const key = `${p.id}|${w.key}`;
        const pts = (series.get(key) || []).concat(w.history || []).filter((x) => x.t > Date.now() - 60 * 60 * 1000);
        series.set(key, pts);
        const set = ensureWan(pbox, key, `${w.name}${w.state ? ` (${w.state})` : ''}`);
        set.rtt.update(pts, WINDOW); set.tput.update(pts, WINDOW); set.loss.update(pts, WINDOW);
      }
    }
  }

  async function poll() {
    try {
      const v = await api(`/fusionhub?since=${since}`);
      const latest = Math.max(0, ...v.peers.flatMap((p) => p.wans.flatMap((w) => (w.history || []).map((x) => x.t))));
      if (latest) since = latest;
      render(v);
    } catch { /* signed out */ }
  }

  $('fhConnect').addEventListener('click', async () => {
    $('fhMsg').textContent = 'Connecting…';
    try {
      await api('/fusionhub/connect', { method: 'POST', body: JSON.stringify({ host: $('fhHost').value, username: $('fhUser').value, password: $('fhPass').value }) });
      $('fhPass').value = '';
      $('fhMsg').textContent = 'Connected. Read-only client created.';
      poll();
    } catch (e) { $('fhMsg').textContent = e.message; $('fhPass').value = ''; }
  });

  poll();
  setInterval(poll, 2000);
})();
