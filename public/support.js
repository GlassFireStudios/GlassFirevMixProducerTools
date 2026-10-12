/* GlassFire Support app (opened from the desktop icon on a show computer).
   The link carries this machine's support key; it can only file and read this
   machine's own requests. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const key = new URLSearchParams(location.search).get('k') || '';
  const CHUNK = 8 * 1024 * 1024;
  const PROMPTS = {
    bug: "What's happening? What did you expect?",
    question: 'What would you like to know?',
    media: 'What is it, and where should it go? (for example: "new Friday video, play after the 8 FRI A loop")',
  };
  const TYPE_LABEL = { bug: 'Problem', question: 'Question', media: 'New media' };
  let type = 'bug';
  try { $('contact').value = localStorage.getItem('gfContact') || ''; } catch { /* storage blocked */ }

  async function api(p, opts = {}) {
    const res = await fetch('/fm/api/support' + p, { ...opts, headers: { 'X-Support-Key': key, ...(opts.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    return body;
  }

  document.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => {
    type = b.dataset.type;
    document.querySelectorAll('.choice').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('prompt').textContent = PROMPTS[type];
    $('message').focus();
  }));

  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function renderStatus(m) {
    const v = m.status?.vmix || {};
    const chips = [];
    chips.push(m.online ? '<span class="chip ok">Connected to GlassFire</span>' : '<span class="chip bad">Not reporting to GlassFire</span>');
    if (m.status) {
      chips.push(v.running ? '<span class="chip ok">vMix running</span>' : '<span class="chip bad">vMix not running</span>');
      if (v.running) chips.push(v.streaming ? '<span class="chip ok">Streaming</span>' : '<span class="chip bad">Not streaming</span>');
      if (v.active) chips.push(`<span class="chip">On screen: ${esc(v.active)}</span>`);
      if (m.status.missingMedia?.length) chips.push(`<span class="chip warn">${m.status.missingMedia.length} media file(s) missing</span>`);
    }
    $('status').innerHTML = chips.join('');
    const notes = m.status?.notes || [];
    $('notes').classList.toggle('hidden', !notes.length);
    $('notes').innerHTML = notes.map((n) => `<div>${esc(n)}</div>`).join('');
  }

  function renderTickets(list) {
    $('tickets').innerHTML = list.length ? list.map((t) => `<div class="ticket">
      <div class="meta">${TYPE_LABEL[t.type]} · ${ago(t.at)} · ${t.status === 'done' ? 'Resolved' : 'Open'}</div>
      <div>${esc(t.message) || '<i>(files only)</i>'}</div>
      ${t.files.length ? `<div class="meta">Files: ${t.files.map((f) => esc(f.name) + (f.done ? '' : ' (incomplete)')).join(', ')}</div>` : ''}
      ${t.replies.map((r) => `<div class="reply"><div class="meta">${esc(r.by)} · ${ago(r.at)}</div>${esc(r.text)}</div>`).join('')}
    </div>`).join('') : '<p class="chip">None yet.</p>';
  }

  async function refresh() {
    try {
      const r = await api('/me');
      $('who').innerHTML = `${esc(r.machine.name)}<br>${r.machine.role === 'V' ? 'Vertical' : 'Horizontal'}`;
      renderStatus(r.machine);
      renderTickets(r.tickets);
    } catch (e) { $('who').textContent = e.message; }
  }

  async function upload(ticketId, file, onProgress) {
    for (let offset = 0; offset < file.size || offset === 0; offset += CHUNK) {
      const chunk = file.slice(offset, Math.min(file.size, offset + CHUNK));
      const q = `?ticket=${encodeURIComponent(ticketId)}&name=${encodeURIComponent(file.name)}&offset=${offset}&size=${file.size}`;
      await api('/upload' + q, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk });
      onProgress(Math.min(file.size, offset + CHUNK));
      if (file.size === 0) break;
    }
  }

  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const message = $('message').value.trim();
    const files = [...$('files').files];
    if (!message && !files.length) { $('msg').className = 'msg err'; $('msg').textContent = 'Write a message or add a file first.'; return; }
    try { localStorage.setItem('gfContact', $('contact').value.trim()); } catch { /* ignore */ }
    $('send').disabled = true;
    $('msg').className = 'msg';
    $('msg').textContent = 'Sending…';
    try {
      const { ticket } = await api('/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, message, contact: $('contact').value.trim() }) });
      if (files.length) {
        const total = files.reduce((n, f) => n + f.size, 0) || 1;
        let doneBytes = 0;
        $('bar').classList.remove('hidden');
        for (const f of files) {
          $('msg').textContent = `Uploading ${f.name}…`;
          await upload(ticket.id, f, (sent) => { $('barFill').style.width = `${Math.round(((doneBytes + sent) / total) * 100)}%`; });
          doneBytes += f.size;
        }
      }
      $('message').value = '';
      $('files').value = '';
      $('msg').className = 'msg ok';
      $('msg').textContent = 'Sent. GlassFire has been notified and will reply here and in Slack.';
      refresh();
    } catch (e) {
      $('msg').className = 'msg err';
      $('msg').textContent = `Not sent: ${e.message} If this keeps happening, post in Slack #field-support.`;
    } finally {
      $('send').disabled = false;
      setTimeout(() => $('bar').classList.add('hidden'), 1500);
    }
  });

  refresh();
  setInterval(refresh, 15000);
})();
