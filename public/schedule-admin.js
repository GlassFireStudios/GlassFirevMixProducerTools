/* Schedule: loop blocks + countdown events per show, with running early/late. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const TZ = 'America/New_York';
  const STEPS = [[-300, '−5m'], [-60, '−1m'], [-30, '−30s'], [30, '+30s'], [60, '+1m'], [300, '+5m']];
  let kit = '';
  let view = null;

  async function api(p, opts = {}) {
    const res = await fetch('/api/admin' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 401) { $('signin').classList.remove('hidden'); throw new Error('Sign in first'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }
  const fail = (e) => { $('err').textContent = e.message; setTimeout(() => ($('err').textContent = ''), 6000); };

  // Venue wall clock as "YYYY-MM-DDTHH:mm:ss" (same format as the schedule).
  function venueNow() {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  }
  const norm = (t) => (t.length === 16 ? `${t}:00` : t);
  const hm = (t) => { const s = norm(t).slice(11); return s.endsWith(':00') ? s.slice(0, 5) : s; };
  function shiftText(sec) {
    if (!sec) return '';
    const a = Math.abs(sec), m = Math.floor(a / 60), s = a % 60;
    return `${m ? `${m}m` : ''}${s ? `${m ? ' ' : ''}${s}s` : ''} ${sec > 0 ? 'late' : 'early'}`;
  }
  function dayTitle(d) {
    const date = new Date(`${d}T12:00:00Z`);
    return [date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }), date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })];
  }

  function render() {
    if (!view) return;
    const now = venueNow();
    const items = view.items.slice().sort((a, b) => (norm(a.effective) < norm(b.effective) ? -1 : 1));
    // Which block is running, and which event is next.
    const blocks = items.filter((i) => i.kind === 'block' && i.enabled !== false);
    const running = blocks.filter((b) => norm(b.effective) <= now).pop() || blocks[0];
    const nextEvent = items.find((i) => i.kind === 'event' && i.enabled !== false && norm(i.effective) > now);
    $('nowText').textContent = `${running ? `Loop: ${running.name}` : ''}${nextEvent ? ` · next countdown: ${nextEvent.title} at ${hm(nextEvent.effective)}` : ''}`;

    const byDay = new Map();
    for (const it of items) {
      const d = norm(it.effective).slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(it);
    }
    $('days').innerHTML = [...byDay.entries()].map(([d, list]) => {
      const [wd, md] = dayTitle(d);
      return `<section class="sch-day"><h2>${wd}<span>${md}</span></h2>${list.map((it) => {
        const t = norm(it.effective);
        const state = it.enabled === false ? 'is-off' : it === running ? 'is-now' : it === nextEvent ? 'is-next' : t <= now ? 'is-past' : '';
        const planned = it.shiftSec ? `<small>planned ${hm(it.start)}</small>` : '<small>on time</small>';
        const shiftTag = it.shiftSec ? `<span class="tag ${it.shiftSec > 0 ? 'late' : 'early'}">${shiftText(it.shiftSec)}</span>` : '';
        const what = it.kind === 'block'
          ? `<b><span class="tag block">Loop</span>${esc(it.name)}${it === running ? ' <span class="tag now">On now</span>' : ''}</b><span class="meta">Auto switch fades to this loop</span>`
          : `<b><span class="tag event">Countdown</span>${esc(it.title)}${it === nextEvent ? ' <span class="tag now">Next</span>' : ''}</b><span class="meta">${esc(it.where)}${it.look && it.look !== 'equip' ? ` · ${esc(it.look)} look` : ''}</span>`;
        return `<div class="sch-row ${state}" data-id="${it.id}">
          <div class="sch-time">${hm(it.effective)}${planned}</div>
          <div class="sch-what">${what} ${shiftTag}</div>
          <div class="sch-ctl">
            ${STEPS.map(([s, l]) => `<button class="btn small secondary" data-shift="${s}" aria-label="Move ${l}">${l}</button>`).join('')}
            <input data-amount placeholder="3, 2:30, 30s" aria-label="Shift amount" />
            <button class="btn small" data-apply>Shift</button>
            ${it.shiftSec ? '<button class="btn small secondary" data-reset>On time</button>' : ''}
            <button class="btn small secondary" data-edit>Edit</button>
          </div></div>`;
      }).join('')}</section>`;
    }).join('') || '<p class="muted">No items yet.</p>';

    $('sync').innerHTML = view.machines.length ? view.machines.map((m) => {
      const cls = !m.online ? 'off' : m.synced ? 'on' : 'warn';
      const txt = !m.online ? 'offline' : m.synced ? 'up to date' : 'updating…';
      return `<span class="pill ${cls}" title="${esc(m.kitVersion)}">${esc(m.name)} · ${txt}</span>`;
    }).join('') : '<span class="pill off">No show computers on this kit yet</span>';
  }

  async function shift(id, body) {
    try { view = await api(`/schedules/${kit}/items/${id}/shift`, { method: 'POST', body: JSON.stringify({ ...body, following: $('following').checked }) }); render(); } catch (e) { fail(e); }
  }

  $('days').addEventListener('click', async (ev) => {
    const row = ev.target.closest('.sch-row');
    if (!row) return;
    const id = row.dataset.id;
    const it = view.items.find((x) => x.id === id);
    if (ev.target.matches('[data-shift]')) return shift(id, { seconds: Number(ev.target.dataset.shift) });
    if (ev.target.matches('[data-apply]')) {
      const v = row.querySelector('[data-amount]').value.trim();
      if (v) return shift(id, { text: v });
    }
    if (ev.target.matches('[data-reset]')) {
      try { view = await api(`/schedules/${kit}/items/${id}`, { method: 'PATCH', body: JSON.stringify({ shiftSec: 0 }) }); render(); } catch (e) { fail(e); }
    }
    if (ev.target.matches('[data-edit]')) openEdit(it);
  });
  $('days').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches('[data-amount]') && ev.target.value.trim()) shift(ev.target.closest('.sch-row').dataset.id, { text: ev.target.value.trim() });
  });

  function openEdit(it, kind) {
    const k = it ? it.kind : kind;
    $('mTitle').textContent = it ? 'Edit' : k === 'block' ? 'New loop block' : 'New countdown event';
    $('fId').value = it?.id || '';
    $('fKind').value = k;
    $('fName').value = it?.name || '';
    $('fTitle').value = it?.title || '';
    $('fWhere').value = it?.where || '';
    $('fLook').value = it?.look || 'equip';
    $('fStart').value = it?.start || venueNow().slice(0, 16);
    $('fEnabled').checked = it ? it.enabled !== false : true;
    for (const w of ['wTitle', 'wWhere', 'wLook']) $(w).classList.toggle('hidden', k === 'block');
    $('wName').classList.toggle('hidden', k !== 'block');
    $('mDelete').classList.toggle('hidden', !it);
    $('modal').classList.remove('hidden');
  }
  $('addEvent').addEventListener('click', () => openEdit(null, 'event'));
  $('addBlock').addEventListener('click', () => openEdit(null, 'block'));
  $('mCancel').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('mSave').addEventListener('click', async () => {
    const id = $('fId').value;
    const body = { kind: $('fKind').value, start: $('fStart').value, enabled: $('fEnabled').checked };
    if (body.kind === 'block') body.name = $('fName').value; else Object.assign(body, { title: $('fTitle').value, where: $('fWhere').value, look: $('fLook').value });
    try {
      view = await api(id ? `/schedules/${kit}/items/${id}` : `/schedules/${kit}/items`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      $('modal').classList.add('hidden');
      render();
    } catch (e) { fail(e); }
  });
  $('mDelete').addEventListener('click', async () => {
    if (!confirm('Delete this from the schedule?')) return;
    try { view = await api(`/schedules/${kit}/items/${$('fId').value}`, { method: 'DELETE' }); $('modal').classList.add('hidden'); render(); } catch (e) { fail(e); }
  });

  async function load() {
    try {
      if (!kit) {
        const r = await api('/schedules');
        $('kit').innerHTML = r.schedules.map((s) => `<option value="${esc(s.kit)}">${esc(s.title)}</option>`).join('');
        kit = r.schedules[0]?.kit || '';
        if (!kit) { $('days').innerHTML = '<p class="muted">No show schedules yet. Publish a kit with a schedule.</p>'; return; }
      }
      // Don't redraw under someone typing a shift.
      if (document.activeElement?.matches?.('[data-amount]') && document.activeElement.value) return;
      view = await api(`/schedules/${kit}`);
      $('signin').classList.add('hidden');
      render();
    } catch (e) { if (e.message !== 'Sign in first') fail(e); }
  }
  $('kit').addEventListener('change', () => { kit = $('kit').value; load(); });
  setInterval(() => { $('clock').textContent = venueNow().slice(11); }, 1000);
  setInterval(render, 15000);
  setInterval(load, 10000);
  load();
})();
