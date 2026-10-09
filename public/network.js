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

  function wanRow(w) {
    const cls = sigClass(w.rsrp, w.sinr);
    const sig = [w.rsrp != null && `RSRP ${w.rsrp}`, w.rsrq != null && `RSRQ ${w.rsrq}`, w.sinr != null && `SINR ${w.sinr}`, w.rssi != null && `RSSI ${w.rssi}`].filter(Boolean).join(' · ');
    const up = /connected|online|ok|up/i.test(String(w.status));
    return `<tr><td><span class="status-dot ${up ? 'ok' : 'offline'}"></span> ${esc(w.name)}</td>
      <td class="small">${esc(w.status || '—')}</td><td class="mono small">${esc(w.ip || '—')}</td>
      <td class="small">${esc([w.carrier, w.band].filter(Boolean).join(' · ') || '—')}</td>
      <td class="mono small sig-${cls}">${esc(sig || '—')}</td></tr>`;
  }

  function pepvpnBlock(d) {
    if (d.pepvpnError) return `<p class="muted small">SpeedFusion: ${esc(d.pepvpnError)}</p>`;
    if (!d.pepvpn) return '';
    return `<details><summary class="muted small">SpeedFusion status</summary><pre class="raw">${esc(JSON.stringify(d.pepvpn, null, 2))}</pre></details>`;
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
        ${d.wans.length ? `<table class="conn-table"><thead><tr><th>WAN</th><th>Status</th><th>IP</th><th>Carrier / band</th><th>Signal</th></tr></thead>
          <tbody>${d.wans.map(wanRow).join('')}</tbody></table>` : '<p class="muted small">No WAN details.</p>'}
        ${pepvpnBlock(d)}
        ${!d.online && d.lastOnline ? `<p class="muted small">Last online ${esc(d.lastOnline)}</p>` : ''}
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
