/* Network page: Starlink service lines, data left this cycle, dish telemetry. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const gb = (v) => (v == null ? '—' : `${v >= 100 ? Math.round(v) : v} GB`);
  const day = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

  async function api(p, opts = {}) {
    const res = await fetch('/api/admin' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  function dish(d) {
    const t = d.telemetry;
    if (!t) return `<li class="muted small">${esc(d.nickname || d.serial || 'Dish')}: no live telemetry (offline or not reporting)</li>`;
    const warn = (t.dropPct ?? 0) > 2 || (t.obstructionPct ?? 0) > 1 || (t.latencyMs ?? 0) > 80;
    const ageMin = t.at ? Math.round((Date.now() - Date.parse(t.at)) / 60000) : null;
    const stale = ageMin != null && ageMin > 2;
    return `<li class="${warn ? 'sig-warn' : ''}"><b>${esc(d.nickname || d.serial || 'Dish')}</b>:
      ${t.downMbps ?? '—'} down / ${t.upMbps ?? '—'} up Mbps · ${t.latencyMs ?? '—'} ms · ${t.dropPct ?? '—'}% drop
      · ${t.obstructionPct ?? '—'}% obstructed · signal ${t.signal ?? '—'}%${t.alerts.length ? ` · alerts: ${esc(t.alerts.join(', '))}` : ''}${stale ? `<span class="muted"> · last report ${ageMin < 120 ? `${ageMin} min` : `${Math.round(ageMin / 60)} h`} ago (dish likely off)</span>` : '<span class="sig-ok"> · live</span>'}</li>`;
  }

  function line(l) {
    const pct = l.limitGB ? Math.max(0, Math.min(100, ((l.leftGB ?? 0) / l.limitGB) * 100)) : null;
    const low = l.leftGB != null && (l.leftGB <= 5 || (pct != null && pct < 10));
    return `<div class="plan${low ? ' low' : ''}">
      <div class="plan-head"><b>${esc(l.nickname || l.serviceLine)}</b>
        <span class="muted small">${esc(l.plan || '')}${l.cycleStart ? ` · cycle ${day(l.cycleStart)} to ${day(l.cycleEnd)}` : ''}</span></div>
      ${l.limitGB != null ? `<div class="plan-bar" role="img" aria-label="${gb(l.leftGB)} left of ${gb(l.limitGB)}"><div style="width:${pct ?? 0}%"></div></div>
        <div class="plan-nums"><span><b>${gb(l.leftGB)}</b> priority data left</span><span class="muted">${gb(l.usedGB)} used of ${gb(l.limitGB)}${pct != null ? ` · ${pct.toFixed(0)}% remaining` : ''}</span></div>`
        : `<div class="plan-nums"><span><b>${gb(l.priorityGB)}</b> priority used this cycle</span><span class="muted">no data limit reported for this plan</span></div>`}
      <p class="muted small">Standard data this cycle: ${gb(l.standardGB)}${l.overageOptIn ? ` · overage on${l.overageGB ? `, ${gb(l.overageGB)} over` : ''}` : ''}${l.lastUpdated ? ` · Starlink updated ${new Date(l.lastUpdated).toLocaleString()}` : ''}</p>
      ${l.blocks.length ? `<p class="small">${l.blocks.map((b) => `${esc(b.name)}: ${gb(b.leftGB)} left of ${gb(b.totalGB)}`).join(' · ')}</p>` : ''}
      ${low ? '<p class="small sig-warn">Running low on priority data.</p>' : ''}
      ${l.dishes.length ? `<ul class="dishes">${l.dishes.map(dish).join('')}</ul>` : ''}
    </div>`;
  }

  function render(v) {
    $('slSetup').classList.toggle('hidden', v.config.configured);
    if (v.config.configured) $('slId').value = v.config.clientId;
    $('slErr').classList.toggle('hidden', !v.error);
    $('slErr').textContent = v.error || '';
    $('slAcct').textContent = v.account ? `${v.account.name} · ${v.account.number}` : '';
    $('slUpdated').textContent = v.usageAt ? `usage ${new Date(v.usageAt).toLocaleTimeString()}` : '';
    $('slLines').innerHTML = v.lines.length ? v.lines.map(line).join('') : (v.config.configured && !v.error ? '<p class="muted">No active service lines returned.</p>' : '');
  }

  async function refresh(force) {
    try { render(force ? await api('/starlink/refresh', { method: 'POST' }) : await api('/starlink')); } catch { /* signed out */ }
  }

  $('slSave').addEventListener('click', async () => {
    $('slMsg').textContent = 'Connecting…';
    try {
      render(await api('/starlink/config', { method: 'PUT', body: JSON.stringify({ clientId: $('slId').value, clientSecret: $('slSecret').value }) }));
      $('slSecret').value = '';
      $('slMsg').textContent = '';
    } catch (e) { $('slMsg').textContent = e.message; }
  });
  $('slRefresh').addEventListener('click', () => refresh(true));
  $('slEdit').addEventListener('click', (e) => { e.preventDefault(); $('slSetup').classList.remove('hidden'); });

  refresh();
  setInterval(refresh, 30000);
})();
