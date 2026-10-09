/* Producer guest manager: vMix machines, vMix Call inputs, guest invites. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = (t) => {
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : new Date(t).toLocaleString();
  };
  const db = (v) => (v == null ? '−∞' : v.toFixed(0));

  async function api(p, opts = {}) {
    const res = await fetch('/api/admin' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 401) { $('signin').classList.remove('hidden'); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  let machines = [];
  let invites = [];
  let joinBase = '';

  function copy(text, btn) {
    navigator.clipboard?.writeText(text);
    const t = btn.textContent; btn.textContent = 'copied'; setTimeout(() => (btn.textContent = t), 1200);
  }

  function stage(i) {
    if (i.callConnected && i.connectedAt) return ['on', 'In the call'];
    if (i.joiningAt) return ['warn', 'Joining vMix Call'];
    if (i.checkedAt) return ['warn', 'Tech check done'];
    if (i.openedAt) return ['warn', 'Opened the link'];
    return ['off', 'Not opened yet'];
  }

  function checkSummary(c) {
    if (!c) return '';
    const bits = [];
    if (c.browser) bits.push(`browser ${c.browser.kind}`);
    if (c.camera) bits.push(c.camera.ok ? `cam ${c.camera.width || '?'}×${c.camera.height || '?'}` : `cam FAILED (${c.camera.error})`);
    if (c.mic) bits.push(c.mic.ok ? 'mic ok' : 'mic silent');
    bits.push(c.headphones ? 'headphones' : 'no headphones');
    if (c.heardChime === false) bits.push("didn't hear chime");
    if (c.net) bits.push(`${c.net.downMbps} down / ${c.net.upMbps} up Mbps, ${c.net.rttMs} ms`);
    return bits.join(' · ');
  }

  function renderInvites() {
    if (!invites.length) { $('invites').innerHTML = '<p class="muted">No invites yet. Use "Invite guest" on a call input below.</p>'; return; }
    $('invites').innerHTML = `<table class="conn-table"><thead><tr><th>Guest</th><th>Show</th><th>Call</th><th>Progress</th><th>Tech check</th><th></th></tr></thead><tbody>
      ${invites.map((i) => {
    const [cls, label] = stage(i);
    const link = `${joinBase}/join/${i.code}`;
    return `<tr><td>${esc(i.guestName)}</td><td>${esc(i.show)}</td>
          <td class="mono">${esc(i.machineLabel)} · ${esc(i.callTitle)}</td>
          <td><span class="pill ${cls}">${label}</span> <span class="muted small">${ago(i.connectedAt || i.joiningAt || i.checkedAt || i.openedAt || i.createdAt)}</span></td>
          <td class="small">${esc(checkSummary(i.check))}</td>
          <td><div class="actions"><button class="btn small" data-copy="${esc(link)}">Copy link</button>
            <button class="btn small danger" data-del="${esc(i.code)}">Delete</button></div></td></tr>`;
  }).join('')}</tbody></table>`;
    $('invites').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b)));
    $('invites').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this invite? The link stops working.')) return;
      await api(`/guests/${b.dataset.del}`, { method: 'DELETE' }); refresh();
    }));
  }

  function renderCalls() {
    const rows = [];
    for (const m of machines) {
      for (const c of m.status?.calls || []) {
        const inv = invites.find((i) => i.machineId === m.id && i.inputKey === c.key);
        rows.push(`<tr><td><span class="status-dot ${c.connected ? 'ok' : 'offline'}"></span> ${c.connected ? '<b>Connected</b>' : '<span class="muted">waiting</span>'}</td>
          <td class="mono">${esc(m.label)}</td><td>${c.number}. ${esc(c.title)}</td>
          <td class="mono small">${esc(c.videoSource || '—')} / ${esc(c.audioSource || '—')}</td>
          <td class="mono small">${db(c.db[0])} / ${db(c.db[1])} dB</td>
          <td>${inv ? `<span class="muted small">${esc(inv.guestName)}</span> ` : ''}<button class="btn small" data-m="${esc(m.id)}" data-k="${esc(c.key)}" data-t="${esc(c.title)}">Invite guest</button></td></tr>`);
      }
    }
    $('calls').innerHTML = rows.length
      ? `<table class="conn-table"><thead><tr><th>Status</th><th>vMix</th><th>Input</th><th>Return video / audio</th><th>Level</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`
      : '<p class="muted">No vMix Call inputs found on the machines below.</p>';
    $('calls').querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => openInvite(b.dataset.m, b.dataset.k, b.dataset.t)));
  }

  function renderMachines() {
    $('machines').innerHTML = machines.length ? `<table class="conn-table"><thead><tr><th>Status</th><th>Name</th><th>Address</th><th>vMix</th><th>Rec</th><th>Stream</th><th>Calls</th><th></th></tr></thead><tbody>
      ${machines.map((m) => {
    const s = m.status;
    const up = s?.reachable;
    return `<tr><td><span class="status-dot ${up ? 'ok' : 'offline'}"></span> ${up ? 'online' : esc(s?.error || 'checking')}</td>
          <td>${esc(m.label)}</td><td class="mono">${esc(m.host)}:${m.port}${m.hasPassword ? '' : ' <span class="pill off" title="vMix Web Controller has no password">no password</span>'}</td>
          <td class="mono small">${esc(s?.version || '')} ${esc(s?.edition || '')}</td>
          <td>${s?.recording ? '<span class="pill on">REC</span>' : '—'}</td><td>${s?.streaming ? '<span class="pill on">LIVE</span>' : '—'}</td>
          <td>${s?.calls?.length ?? '—'}</td>
          <td><div class="actions"><button class="btn small secondary" data-edit="${esc(m.id)}">Edit</button><button class="btn small danger" data-rm="${esc(m.id)}">Remove</button></div></td></tr>`;
  }).join('')}</tbody></table>` : '<p class="muted">No vMix machines yet. Add one with its private IP (e.g. vMix1 = 172.31.73.35).</p>';
    $('machines').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openMachine(machines.find((x) => x.id === b.dataset.edit))));
    $('machines').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this vMix from Live Tools?')) return;
      await api(`/vmix/${b.dataset.rm}`, { method: 'DELETE' }); refresh();
    }));
  }

  async function refresh() {
    try {
      const [m, g] = await Promise.all([api('/vmix'), api('/guests')]);
      machines = m.machines; invites = g.invites; joinBase = g.joinBase;
      $('signin').classList.add('hidden');
      renderInvites(); renderCalls(); renderMachines();
    } catch { /* signed out */ }
  }

  // invite modal
  function openInvite(machineId, inputKey, title) {
    $('invMachine').value = machineId; $('invInput').value = inputKey;
    $('invTitle').textContent = `Invite a guest to ${title}`;
    $('invName').value = ''; $('invOut').innerHTML = '';
    $('invCreate').disabled = false;
    $('invModal').classList.remove('hidden');
    $('invName').focus();
  }
  $('invClose').addEventListener('click', () => $('invModal').classList.add('hidden'));
  $('invCreate').addEventListener('click', async () => {
    try {
      const r = await api('/guests', { method: 'POST', body: JSON.stringify({ machineId: $('invMachine').value, inputKey: $('invInput').value, guestName: $('invName').value, show: $('invShow').value }) });
      $('invOut').innerHTML = `<div class="kv"><span class="k">Guest link</span><code class="v">${esc(r.link)}</code><button class="btn small secondary" id="invCopy">copy</button></div>
        <p class="muted small">Send this to the guest. You'll see their progress in Invites.</p>`;
      $('invCopy').addEventListener('click', (e) => copy(r.link, e.target));
      $('invCreate').disabled = true;
      refresh();
    } catch (e) { $('invOut').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  });

  // machine modal
  let editingId = null;
  function openMachine(m) {
    editingId = m ? m.id : null;
    $('mLabel').value = m?.label || '';
    $('mHost').value = m?.host || '';
    $('mPort').value = m?.port || 8088;
    $('mUser').value = m?.username || '';
    $('mPass').value = '';
    $('mPass').placeholder = m?.hasPassword ? '(unchanged)' : '';
    $('mSave').textContent = m ? 'Save' : 'Add';
    $('mModal').classList.remove('hidden');
  }
  $('addMachine').addEventListener('click', () => openMachine(null));
  $('mClose').addEventListener('click', () => $('mModal').classList.add('hidden'));
  $('mSave').addEventListener('click', async () => {
    try {
      const body = { label: $('mLabel').value, host: $('mHost').value, port: $('mPort').value, username: $('mUser').value };
      if ($('mPass').value) body.password = $('mPass').value;
      if (editingId) await api(`/vmix/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/vmix', { method: 'POST', body: JSON.stringify({ ...body, password: body.password || '' }) });
      $('mModal').classList.add('hidden'); $('mPass').value = '';
      refresh();
    } catch (e) { alert(e.message); }
  });

  refresh();
  setInterval(refresh, 2000);
})();
