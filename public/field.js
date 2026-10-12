/* Field: GlassFire show computers (NUCs), their kit licence, and support requests. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const TYPE = { bug: ['Problem', 'sig-bad'], question: ['Question', 'sig-warn'], media: ['New media', 'sig-ok'] };
  let data = null;

  async function api(p, opts = {}) {
    const res = await fetch('/api/admin' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 401) { $('signin').classList.remove('hidden'); throw new Error('unauthorized'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }
  const ago = (t) => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : new Date(t).toLocaleString(); };
  const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const showCmd = (cmd) => { $('cmd').textContent = cmd; $('cmdModal').classList.remove('hidden'); };

  function renderTickets() {
    const list = data.tickets.filter((t) => $('showDone').checked || t.status !== 'done');
    $('tickets').innerHTML = list.length ? list.map((t) => {
      const [label, cls] = TYPE[t.type] || ['?', ''];
      return `<div class="panel" style="margin:.5rem 0;padding:.7rem .9rem">
        <div class="section-head"><b class="${cls}">${label}</b><span class="muted small">${esc(t.machineName)} · ${ago(t.at)}${t.contact ? ` · ${esc(t.contact)}` : ''}</span><div class="spacer"></div>
          <button class="btn small secondary" data-status="${t.id}" data-to="${t.status === 'done' ? 'open' : 'done'}">${t.status === 'done' ? 'Reopen' : 'Resolve'}</button></div>
        <p style="white-space:pre-wrap;margin:.3rem 0">${esc(t.message) || '<i class="muted">(files only)</i>'}</p>
        ${t.files.length ? `<p class="small">${t.files.map((f) => `<a href="/api/admin/field/tickets/${t.id}/files/${encodeURIComponent(f.name)}">${esc(f.name)}</a> <span class="muted">${(f.size / 1048576).toFixed(1)} MB${f.done ? '' : ', incomplete'}</span>`).join(' · ')}</p>` : ''}
        ${t.context?.vmix ? `<p class="small muted">At the time: vMix ${t.context.vmix.running ? 'running' : 'not running'}${t.context.vmix.active ? `, on air "${esc(t.context.vmix.active)}"` : ''}${t.context.vmix.streaming ? ', streaming' : ', not streaming'} · kit ${esc(t.context.kitVersion || '?')}</p>` : ''}
        ${t.replies.map((r) => `<p class="small" style="border-left:3px solid var(--accent,#ff6a2b);padding-left:.6rem"><b>${esc(r.by)}</b> <span class="muted">${ago(r.at)}</span><br>${esc(r.text)}</p>`).join('')}
        <div class="row"><input class="grow" data-reply-text="${t.id}" placeholder="Reply (shows in their Support app)" style="flex:1" /><button class="btn small" data-reply="${t.id}">Reply</button></div>
      </div>`;
    }).join('') : '<p class="muted">No open requests.</p>';
    $('tickets').querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => { await api(`/field/tickets/${b.dataset.status}/status`, { method: 'POST', body: JSON.stringify({ status: b.dataset.to }) }); load(); }));
    $('tickets').querySelectorAll('[data-reply]').forEach((b) => b.addEventListener('click', async () => {
      const input = $('tickets').querySelector(`[data-reply-text="${b.dataset.reply}"]`);
      if (!input.value.trim()) return;
      await api(`/field/tickets/${b.dataset.reply}/reply`, { method: 'POST', body: JSON.stringify({ text: input.value.trim() }) });
      load();
    }));
  }

  function renderMachines() {
    $('machines').innerHTML = data.machines.length ? `<table class="conn-table small"><thead><tr>
      <th></th><th>Computer</th><th>vMix</th><th>On air</th><th>Kit</th><th>Media</th><th>Clock / disk</th><th>Licence ends</th><th>Seen</th><th></th></tr></thead><tbody>
      ${data.machines.map((m) => {
        const s = m.status || {};
        const v = s.vmix || {};
        const dot = !m.enrolled ? '' : m.online ? 'ok' : 'offline';
        return `<tr>
          <td><span class="status-dot ${dot}"></span></td>
          <td><b>${esc(m.name)}</b> <span class="muted">${m.role === 'V' ? 'vertical' : 'horizontal'}</span><div class="muted">${esc(m.hostname || (m.enrolled ? '' : 'not installed yet'))}</div></td>
          <td>${!m.status ? '' : v.running ? `${v.streaming ? '<span class="sig-ok">streaming</span>' : '<span class="sig-bad">not streaming</span>'}${v.recording ? ' · rec' : ''}<div class="muted">${esc((v.preset || '').split(/[\\/]/).pop())}</div>` : '<span class="sig-bad">not running</span>'}</td>
          <td>${esc(v.active || '')}${v.overlays?.length ? `<div class="muted">+ ${v.overlays.map(esc).join(', ')}</div>` : ''}</td>
          <td class="mono">${esc(s.kitVersion || '')}${s.notes?.length ? `<div class="sig-warn" title="${esc(s.notes.join('\n'))}">${s.notes.length} note(s)</div>` : ''}</td>
          <td>${!m.status ? '' : s.missingMedia?.length ? `<span class="sig-warn" title="${esc(s.missingMedia.join('\n'))}">${s.missingMedia.length} missing</span>` : '<span class="sig-ok">all present</span>'}</td>
          <td>${esc(s.timezone || '')}<div class="muted">${s.diskFreeGB != null && m.status ? `${s.diskFreeGB} GB free` : ''}</div></td>
          <td>${m.revoked ? '<span class="sig-bad">revoked</span>' : ''}<input type="datetime-local" data-exp="${m.id}" value="${localInput(m.expiresAt)}" />${m.expired ? `<div class="${s.expiredApplied ? 'sig-bad' : 'sig-warn'}">${s.expiredApplied ? 'kit removed' : 'ended, removal pending'}</div>` : ''}</td>
          <td class="muted">${ago(m.lastSeen)}</td>
          <td class="actions"><button class="btn small secondary" data-code="${m.id}">Install code</button>
            <button class="btn small secondary" data-revoke="${m.id}" data-to="${m.revoked ? '0' : '1'}">${m.revoked ? 'Un-revoke' : 'Revoke now'}</button>
            <button class="btn small danger" data-del="${m.id}">Delete</button></td></tr>`;
      }).join('')}</tbody></table>` : '<p class="muted">No computers yet. Add one, then run the install command on it.</p>';
    $('machines').querySelectorAll('[data-exp]').forEach((i) => i.addEventListener('change', async () => {
      await api(`/field/machines/${i.dataset.exp}`, { method: 'PATCH', body: JSON.stringify({ expiresAt: i.value ? new Date(i.value).toISOString() : '' }) }); load();
    }));
    $('machines').querySelectorAll('[data-code]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Make a new install code? Installing with it replaces this computer\'s current key.')) return;
      showCmd((await api(`/field/machines/${b.dataset.code}/code`, { method: 'POST' })).command);
    }));
    $('machines').querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.to === '1' && !confirm('Revoke now? The computer removes the kit files at its next check-in (not while vMix is streaming or recording).')) return;
      await api(`/field/machines/${b.dataset.revoke}`, { method: 'PATCH', body: JSON.stringify({ revoked: b.dataset.to === '1' }) }); load();
    }));
    $('machines').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this computer from the list? It stops getting updates.')) return;
      await api(`/field/machines/${b.dataset.del}`, { method: 'DELETE' }); load();
    }));
  }

  function renderKits() {
    $('kits').innerHTML = data.kits.length
      ? data.kits.map((k) => `<p><b>${esc(k.kit)}</b> <span class="mono">${esc(k.version)}</span> · ${k.files} kit files · ${k.media} media files${k.publishedAt ? ` · published ${new Date(k.publishedAt).toLocaleString()}` : ''}</p>`).join('')
      : '<p class="muted">No kits published yet (scripts/kit-publish.mjs).</p>';
    $('fKit').innerHTML = data.kits.map((k) => `<option>${esc(k.kit)}</option>`).join('');
    $('slackState').textContent = `${data.slack ? 'Slack is connected.' : 'Slack is not connected yet.'} Uploads use ${(data.uploadsBytes / 1073741824).toFixed(2)} of ${(data.uploadCap / 1073741824).toFixed(0)} GB.`;
  }

  async function load() {
    try {
      data = await api('/field');
      $('signin').classList.add('hidden');
      renderTickets(); renderMachines(); renderKits();
    } catch { /* signed out */ }
  }

  $('showDone').addEventListener('change', renderTickets);
  $('add').addEventListener('click', () => { $('modal').classList.remove('hidden'); $('fName').focus(); });
  $('cancel').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('create').addEventListener('click', async () => {
    try {
      const r = await api('/field/machines', { method: 'POST', body: JSON.stringify({ name: $('fName').value, role: $('fRole').value, kit: $('fKit').value, expiresAt: $('fExp').value ? new Date($('fExp').value).toISOString() : '' }) });
      $('modal').classList.add('hidden');
      showCmd(r.command);
      load();
    } catch (e) { alert(e.message); }
  });
  $('cmdCopy').addEventListener('click', () => { navigator.clipboard?.writeText($('cmd').textContent); $('cmdCopy').textContent = 'Copied'; setTimeout(() => ($('cmdCopy').textContent = 'Copy'), 1200); });
  $('cmdClose').addEventListener('click', () => $('cmdModal').classList.add('hidden'));
  $('slackSave').addEventListener('click', async () => {
    try { await api('/field/slack', { method: 'PUT', body: JSON.stringify({ url: $('slackUrl').value.trim() }) }); $('slackUrl').value = ''; load(); } catch (e) { alert(e.message); }
  });
  $('slackTest').addEventListener('click', async () => { const r = await api('/field/slack/test', { method: 'POST' }); $('slackState').textContent = r.ok ? 'Test message posted.' : 'Slack did not accept the test. Check the webhook URL.'; });
  load();
  setInterval(load, 15000);
})();
