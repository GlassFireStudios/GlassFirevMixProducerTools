/* Admin dashboard logic. Plain browser script, no build step. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let producerBase = location.origin; // overridden by tunnel base URL when up

  async function api(path, opts = {}) {
    const res = await fetch('/api/admin' + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.status === 204 ? null : res.json();
  }

  // ---- auth ----------------------------------------------------------------
  function showLogin() { $('login').classList.remove('hidden'); $('app').classList.add('hidden'); }
  function showApp() { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('loginPw').value }),
      });
      if (!res.ok) { $('loginErr').textContent = 'Incorrect password'; return; }
      $('loginPw').value = '';
      const next = new URLSearchParams(location.search).get('next');
      if (next && next.startsWith('/') && !next.startsWith('//')) { location.href = next; return; }
      showApp(); start();
    } catch { $('loginErr').textContent = 'Login failed'; }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    showLogin();
  });

  // ---- connections table ---------------------------------------------------
  function fmtTime(ms) {
    if (ms == null) return '—';
    const t = Math.max(0, Math.round(ms / 1000));
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }
  function statusDot(st) {
    if (!st) return 'offline';
    if (!st.reachable) return 'offline';
    return st.zone || 'ok';
  }

  let connCache = [];

  async function refreshConnections() {
    const { connections } = await api('/connections');
    connCache = connections;
    const tbody = $('connRows');
    $('connEmpty').classList.toggle('hidden', connections.length > 0);
    tbody.replaceChildren(...connections.map((c, i) => renderRow(c, i, connections.length)));
  }

  function producerLink(id) {
    let url = producerBase.replace(/\/$/, '') + '/s/' + encodeURIComponent(id);
    if (window.__producerToken) url += '?k=' + encodeURIComponent(window.__producerToken);
    return url;
  }

  function renderRow(c, i, total) {
    const tr = document.createElement('tr');
    const st = c.status;
    const dot = statusDot(st);
    const target = `${esc(c.host || '—')}:${c.port}`;
    const remaining = st && st.reachable ? fmtTime(st.remainingMs) : '—';
    const now = st && st.reachable ? esc(st.item || st.vmixState || '') : (st && st.error ? 'offline · ' + esc(st.error) : 'offline');
    const link = producerLink(c.id);

    tr.innerHTML = `
      <td>
        <div class="actions">
          <button class="btn small secondary" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn small secondary" data-act="down" ${i === total - 1 ? 'disabled' : ''}>↓</button>
        </div>
      </td>
      <td><span class="status-dot ${dot}" title="${esc(st && st.error ? st.error : (st ? st.vmixState : 'no data'))}"></span></td>
      <td><span class="swatch" style="background:${esc(c.color)}"></span> ${esc(c.label)}</td>
      <td class="mono">${target}</td>
      <td class="mono">${esc(c.input)}</td>
      <td class="mono">${remaining}</td>
      <td>${now}</td>
      <td><span class="pill ${c.enabled ? 'on' : 'off'}" data-act="toggle" style="cursor:pointer">${c.enabled ? 'enabled' : 'disabled'}</span></td>
      <td><span class="copylink"><a href="${esc(link)}" target="_blank" rel="noopener">open</a> <button class="btn small secondary" data-act="copy">copy</button></span></td>
      <td><div class="actions">
        <button class="btn small secondary" data-act="edit">Edit</button>
        <button class="btn small danger" data-act="del">Remove</button>
      </div></td>`;

    tr.querySelectorAll('[data-act]').forEach((el) => {
      el.addEventListener('click', () => handleRowAction(el.dataset.act, c, i));
    });
    return tr;
  }

  async function handleRowAction(act, c, i) {
    if (act === 'toggle') {
      await api(`/connections/${c.id}/enable`, { method: 'POST', body: JSON.stringify({ enabled: !c.enabled }) });
      refreshConnections();
    } else if (act === 'del') {
      if (!confirm(`Remove “${c.label}”?`)) return;
      await api(`/connections/${c.id}`, { method: 'DELETE' });
      refreshConnections();
    } else if (act === 'edit') {
      openModal(c);
    } else if (act === 'copy') {
      navigator.clipboard?.writeText(producerLink(c.id));
    } else if (act === 'up' || act === 'down') {
      const ids = connCache.map((x) => x.id);
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await api('/connections/reorder', { method: 'POST', body: JSON.stringify({ order: ids }) });
      refreshConnections();
    }
  }

  // ---- add/edit modal ------------------------------------------------------
  function openModal(c) {
    $('modalTitle').textContent = c ? 'Edit connection' : 'Add connection';
    $('fId').value = c?.id || '';
    $('fLabel').value = c?.label || '';
    $('fHost').value = c?.host || '';
    $('fPort').value = c?.port || 8088;
    $('fColor').value = c?.color || '#3aa0ff';
    $('fUser').value = c?.username || '';
    $('fPass').value = '';
    $('fInput').value = c?.input || 'active';
    $('fWarn').value = c?.warnSeconds ?? 30;
    $('fDanger').value = c?.dangerSeconds ?? 10;
    $('testOut').classList.add('hidden');
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); }

  function modalBody() {
    return {
      label: $('fLabel').value.trim(),
      host: $('fHost').value.trim(),
      port: parseInt($('fPort').value, 10) || 8088,
      color: $('fColor').value,
      username: $('fUser').value,
      password: $('fPass').value,
      input: $('fInput').value.trim() || 'active',
      warnSeconds: parseInt($('fWarn').value, 10) || 0,
      dangerSeconds: parseInt($('fDanger').value, 10) || 0,
    };
  }

  $('addBtn').addEventListener('click', () => openModal(null));
  $('cancelBtn').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

  $('saveBtn').addEventListener('click', async () => {
    const body = modalBody();
    if (!body.label || !body.host) { alert('Label and host are required'); return; }
    const id = $('fId').value;
    if (id) await api('/connections/' + id, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/connections', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    refreshConnections();
  });

  $('testBtn').addEventListener('click', async () => {
    const out = $('testOut');
    out.classList.remove('hidden');
    out.textContent = 'Testing…';
    const b = modalBody();
    try {
      const r = await api('/test', { method: 'POST', body: JSON.stringify(b) });
      out.textContent = [
        `reachable:   ${r.reachable ? 'yes' : 'no'}${r.error ? ' (' + r.error + ')' : ''}`,
        `auth-ok:     ${r.authOk ? 'yes' : 'no'}`,
        `input-found: ${r.inputFound ? 'yes' : 'no'}`,
        `vMix state:  ${r.vmixState || '—'}`,
        `remaining:   ${r.remainingMs == null ? '—' : fmtTime(r.remainingMs)}`,
        `now:         ${r.item || '—'}`,
      ].join('\n');
    } catch (e) { out.textContent = 'Test failed: ' + e.message; }
  });

  // ---- tunnel panel --------------------------------------------------------
  async function refreshTunnel() {
    let t;
    try { t = await api('/tunnel/status'); } catch { return; }
    if (t.baseUrl) producerBase = t.baseUrl;
    const statusColors = { connected: 'ok', starting: 'warn', installing: 'warn', retrying: 'warn', stopped: 'off', error: 'danger' };
    const cls = statusColors[t.status] || 'off';
    const links = connCache.filter((c) => c.enabled).slice(0, 6).map((c) =>
      `<div class="copylink"><code>${esc(producerLink(c.id))}</code> <button class="btn small secondary" data-copy="${esc(producerLink(c.id))}">copy</button></div>`
    ).join('');
    $('tunnelPanel').innerHTML = `
      <div class="row" style="align-items:center">
        <div><span class="pill ${cls === 'ok' ? 'on' : 'off'}">${esc(t.status)}</span>
          <span class="muted" style="margin-left:.5rem">mode: ${esc(t.mode)}${t.tokenSet ? '' : ' · no token'}</span></div>
        <div>
          <button class="btn" id="tunStart" ${t.running ? 'disabled' : ''}>Start</button>
          <button class="btn secondary" id="tunStop" ${t.running ? '' : 'disabled'}>Stop</button>
        </div>
      </div>
      ${t.lastError ? `<div class="muted" style="margin:.4rem 0">last error: ${esc(t.lastError)}</div>` : ''}
      <div style="margin-top:.6rem">Public base URL: ${t.baseUrl ? `<a href="${esc(t.baseUrl)}" target="_blank" rel="noopener">${esc(t.baseUrl)}</a>` : '<span class="muted">(not available yet)</span>'}</div>
      <div style="margin-top:.6rem">${links || '<span class="muted">Enable a connection to get producer links.</span>'}</div>`;

    $('tunStart')?.addEventListener('click', async () => { await api('/tunnel/start', { method: 'POST' }); refreshTunnel(); });
    $('tunStop')?.addEventListener('click', async () => { await api('/tunnel/stop', { method: 'POST' }); refreshTunnel(); });
    $('tunnelPanel').querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', () => navigator.clipboard?.writeText(b.dataset.copy)));
  }

  // ---- settings ------------------------------------------------------------
  async function refreshSettings() {
    const s = await api('/settings');
    $('producerToken').placeholder = s.producerTokenSet ? '•••••• (set — type to replace, clear to disable)' : 'leave blank to disable';
    $('tunnelMode').value = s.tunnel.mode;
    $('tunnelToken').placeholder = s.tunnel.tokenSet ? '•••••• (set — type to replace)' : 'paste token';
  }

  $('saveSettings').addEventListener('click', async () => {
    const body = {
      producerToken: $('producerToken').value,
      tunnelMode: $('tunnelMode').value,
    };
    if ($('tunnelToken').value) body.tunnelToken = $('tunnelToken').value;
    const s = await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
    window.__producerToken = $('producerToken').value || (s.producerTokenSet ? window.__producerToken : '');
    $('producerToken').value = '';
    $('tunnelToken').value = '';
    $('settingsSaved').textContent = 'saved ✓';
    setTimeout(() => ($('settingsSaved').textContent = ''), 2000);
    refreshSettings(); refreshConnections(); refreshTunnel();
  });

  // ---- admin password ------------------------------------------------------
  $('pwSave').addEventListener('click', async () => {
    const msg = $('pwMsg');
    msg.textContent = '';
    if ($('pwNext').value !== $('pwConfirm').value) { msg.textContent = 'New passwords do not match'; return; }
    try {
      await api('/password', { method: 'PUT', body: JSON.stringify({ current: $('pwCurrent').value, next: $('pwNext').value }) });
      ['pwCurrent', 'pwNext', 'pwConfirm'].forEach((id) => ($(id).value = ''));
      msg.textContent = 'Password changed';
    } catch (e) { msg.textContent = 'Not changed: ' + e.message; }
  });

  // ---- lifecycle -----------------------------------------------------------
  let timer = null;
  async function start() {
    await refreshSettings();
    await refreshConnections();
    await refreshTunnel();
    if (timer) clearInterval(timer);
    timer = setInterval(() => { refreshConnections().catch(() => {}); refreshTunnel().catch(() => {}); }, 1500);
  }

  (async function init() {
    const { authed } = await fetch('/api/admin/session').then((r) => r.json()).catch(() => ({ authed: false }));
    if (authed) { showApp(); start(); } else { showLogin(); }
  })();
})();
