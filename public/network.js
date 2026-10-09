/* Network page: Peplink devices, WAN links, cellular signal, SpeedFusion. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function api(p, opts = {}) {
    const res = await fetch('/api/admin' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 401) { $('signin').classList.remove('hidden'); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  // Signal quality buckets (LTE RSRP / SINR rules of thumb).
  function sigClass(rsrp, sinr) {
    if (rsrp == null && sinr == null) return '';
    if ((rsrp ?? -200) >= -90 && (sinr ?? 99) >= 13) return 'ok';
    if ((rsrp ?? -200) >= -105 && (sinr ?? 99) >= 0) return 'warn';
    return 'bad';
  }

  // IC2 reports KB; show decimal GB like carriers do.
  const gb = (kb) => (kb == null ? '—' : `${(kb / 1e6).toFixed(kb >= 1e7 ? 0 : 1)} GB`);
  const LOW_KB = 5e6;
  function dataLeft(w) {
    if (w.leftKb == null) return '<span class="muted">—</span>';
    const low = w.leftKb <= LOW_KB;
    return `<span class="${w.leftKb === 0 ? 'sig-bad' : low ? 'sig-warn' : ''}">${gb(w.leftKb)} left</span> <span class="muted small">(${esc(w.quotaSource || '')})</span>`;
  }

  function planBlock(d) {
    const pl = d.plan;
    if (!pl) return '';
    const pct = pl.quotaKb ? Math.max(0, Math.min(100, (pl.leftKb / pl.quotaKb) * 100)) : null;
    const low = pl.leftKb != null && (pl.leftKb <= LOW_KB || (pct != null && pct < 10));
    return `<div class="plan${low ? ' low' : ''}">
      <div class="plan-head"><b>${esc(pl.name)}</b><span class="muted small">${pl.expiry ? `expires ${new Date(pl.expiry).toLocaleDateString()}` : ''}</span></div>
      <div class="plan-bar" role="img" aria-label="${gb(pl.leftKb)} left of ${gb(pl.quotaKb)}"><div style="width:${pct ?? 0}%"></div></div>
      <div class="plan-nums"><span><b>${gb(pl.leftKb)}</b> left</span><span class="muted">${gb(pl.usedKb)} used of ${gb(pl.quotaKb)}${pct != null ? ` · ${pct.toFixed(0)}% remaining` : ''}</span></div>
      ${low ? '<p class="small sig-warn">Running low. Top up before the next show.</p>' : ''}
    </div>`;
  }

  function wanRow(w) {
    const cls = sigClass(w.rsrp, w.sinr) || (w.led === 'green' ? 'ok' : w.led === 'yellow' || w.led === 'orange' ? 'warn' : w.led === 'red' ? 'bad' : '');
    const sig = [w.rsrp != null && `RSRP ${w.rsrp}`, w.rsrq != null && `RSRQ ${w.rsrq}`, w.sinr != null && `SINR ${w.sinr}`, w.rssi != null && `RSSI ${w.rssi}`, w.bars != null && `${w.bars}/5 bars`].filter(Boolean).join(' · ');
    const up = /connected|online|ok|up/i.test(String(w.status));
    return `<tr><td><span class="status-dot ${up ? 'ok' : 'offline'}"></span> ${esc(w.name)}</td>
      <td class="small">${esc(w.status || '—')}</td><td class="mono small">${esc(w.ip || '—')}</td>
      <td class="small">${esc([w.carrier, w.band].filter(Boolean).join(' · ') || '—')}</td>
      <td class="mono small sig-${cls}">${esc(sig || '—')}</td><td class="small">${dataLeft(w)}</td></tr>`;
  }

  function pepvpnBlock(d) {
    if (d.pepvpnError) return `<p class="muted small">SpeedFusion: ${esc(d.pepvpnError)}</p>`;
    const list = d.tunnelList || [];
    if (!list.length) return '';
    return `<h3 class="subhead">SpeedFusion tunnels</h3><table class="conn-table"><thead><tr><th>Peer</th><th>Tunnel</th><th>State</th><th>Encrypted</th></tr></thead><tbody>
      ${list.map((t) => `<tr><td><span class="status-dot ${t.remoteOnline ? 'ok' : 'offline'}"></span> ${esc(t.local)} to ${esc(t.remote)}</td>
        <td class="small">${esc(t.tunnel || '')}</td>
        <td class="small">${t.remoteOnline ? esc(t.status) : 'remote offline'}</td><td class="small">${t.secure ? 'yes' : 'no'}</td></tr>`).join('')}</tbody></table>
      ${d.tunnelStat ? `<details><summary class="muted small">Per-link tunnel stats (raw)</summary><pre class="raw">${esc(JSON.stringify(d.tunnelStat, null, 2))}</pre></details>` : ''}`;
  }

  function fmtUptime(s) {
    if (s == null) return '';
    const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }

  function render(v) {
    $('setup').classList.toggle('hidden', v.config.configured);
    if (v.config.configured) { $('cid').value = v.config.clientId; $('org').value = v.config.orgId; }
    $('err').classList.toggle('hidden', !v.error);
    $('err').textContent = v.error || '';
    $('updated').textContent = v.updatedAt ? `updated ${new Date(v.updatedAt).toLocaleTimeString()}` : '';
    if (!v.devices.length) { $('devices').innerHTML = v.config.configured ? '<p class="muted">No devices returned yet.</p>' : ''; return; }
    const sorted = v.devices.slice().sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
    $('devices').innerHTML = sorted.map((d) => `
      <div class="panel">
        <div class="section-head">
          <span class="status-dot ${d.online ? 'ok' : 'offline'}"></span>
          <h2 style="margin:0">${esc(d.name)}</h2>
          <span class="pill ${d.online ? 'on' : 'off'}">${d.online ? 'online' : 'offline'}</span>
          <div class="spacer"></div>
          <span class="muted small">${esc([d.model, d.firmware && `fw ${d.firmware}`, d.sn].filter(Boolean).join(' · '))}</span>
        </div>
        ${planBlock(d)}
        ${d.monthUsage ? `<p class="muted small">This month through SpeedFusion: ${(d.monthUsage.downMb / 1000).toFixed(1)} GB down · ${(d.monthUsage.upMb / 1000).toFixed(1)} GB up</p>` : ''}
        ${d.wans.length ? `<table class="conn-table"><thead><tr><th>WAN</th><th>Status</th><th>IP</th><th>Carrier / band</th><th>Signal</th><th>Data</th></tr></thead>
          <tbody>${d.wans.map(wanRow).join('')}</tbody></table>` : '<p class="muted small">No WAN details.</p>'}
        ${pepvpnBlock(d)}
        <p class="muted small">${d.online ? `Up ${fmtUptime(d.uptimeSec)}` : d.lastOnline ? `Last online ${new Date(d.lastOnline + 'Z').toLocaleString()}` : ''}
          ${d.address ? ` · ${esc(d.address)}` : ''}${d.clients != null ? ` · ${d.clients} client(s)` : ''}</p>
        ${d.expired ? '<p class="result warn">InControl subscription expired. This unit stops reporting until it is renewed.</p>' : ''}
      </div>`).join('');
  }

  async function refresh(force) {
    try {
      const v = force ? await api('/peplink/refresh', { method: 'POST' }) : await api('/peplink');
      $('signin').classList.add('hidden');
      render(v);
      if (v.config.configured) $('raw').textContent = JSON.stringify(await api('/peplink/raw'), null, 2).slice(0, 60000);
    } catch { /* signed out */ }
  }

  $('save').addEventListener('click', async () => {
    if ($('cid').value.includes('@')) { $('saveMsg').textContent = 'That looks like your login email. Use the API client\'s Client ID instead.'; return; }
    $('saveMsg').textContent = 'Connecting…';
    try {
      await api('/peplink/config', { method: 'PUT', body: JSON.stringify({ clientId: $('cid').value, clientSecret: $('csec').value, orgId: $('org').value }) });
      $('csec').value = '';
      setTimeout(() => { refresh(true); $('saveMsg').textContent = ''; }, 1500);
    } catch (e) { $('saveMsg').textContent = e.message; }
  });
  $('refresh').addEventListener('click', () => refresh(true));
  $('editCfg').addEventListener('click', (e) => { e.preventDefault(); $('setup').classList.remove('hidden'); });

  refresh();
  setInterval(refresh, 30000);
})();
