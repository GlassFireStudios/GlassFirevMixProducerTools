/* Shows admin: create/edit white-label watch pages. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let shows = [];
  let base = '';

  async function api(p, opts = {}) {
    const res = await fetch('/api/admin' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 401) { $('signin').classList.remove('hidden'); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  function render() {
    $('list').innerHTML = shows.length ? shows.map((s) => {
      const url = `${base}/${s.slug}`;
      return `<section class="panel"><div class="section-head">
        ${s.logoUrl ? `<img src="${esc(s.logoUrl)}" alt="" style="height:28px;background:${esc(s.background)};padding:4px;border-radius:4px">` : ''}
        <h2 style="margin:0">${esc(s.title)}</h2><span class="pill off">${s.orientation === 'vertical' ? '9:16 vertical' : '16:9 horizontal'}</span>
        ${s.enabled === false ? '<span class="pill off">disabled</span>' : ''}<div class="spacer"></div>
        <a class="btn small secondary" href="${esc(url)}" target="_blank" rel="noopener">Open</a>
        <button class="btn small secondary" data-copy="${esc(url)}">Copy link</button>
        <button class="btn small" data-edit="${esc(s.slug)}">Edit</button>
        <button class="btn small danger" data-del="${esc(s.slug)}">Delete</button></div>
        <p class="mono small muted">${esc(url)}${s.playbackUrl ? '' : ' · <span class="sig-warn">no playback URL yet</span>'}</p>
        <p class="small">TV links:
          ${[['tv', 'full screen'], ['rotate=90', 'rotated 90°'], ['rotate=270', 'rotated 270°'], ['rotate=180', 'upside down']]
    .map(([qs, label]) => `<button class="btn small secondary" data-copy="${esc(url)}?${qs}">${label}</button>`).join(' ')}
          <span class="muted"> · add &amp;fit=cover to fill edge to edge, &amp;sound=1 to try starting with sound</span></p></section>`;
    }).join('') : '<p class="muted">No shows yet.</p>';
    $('list').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => { const label = b.textContent; navigator.clipboard?.writeText(b.dataset.copy); b.textContent = 'copied'; setTimeout(() => (b.textContent = label), 1200); }));
    $('list').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => open(shows.find((s) => s.slug === b.dataset.edit))));
    $('list').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this show page? The link stops working.')) return;
      await api(`/shows/${b.dataset.del}`, { method: 'DELETE' }); load();
    }));
  }

  function open(s) {
    $('mTitle').textContent = s ? `Edit ${s.title}` : 'New show';
    $('fSlugOld').value = s?.slug || '';
    $('fSlug').value = s?.slug || '';
    $('fSlug').disabled = !!s;
    $('fTitle').value = s?.title || '';
    $('fSub').value = s?.subtitle || '';
    $('fUrl').value = s?.playbackUrl || '';
    $('fLogo').value = s?.logoUrl || '';
    $('fOrient').value = s?.orientation || 'horizontal';
    $('fAccent').value = s?.accent || '#ffffff';
    $('fBg').value = s?.background || '#15181d';
    $('fOff').value = s?.offlineMessage || '';
    $('modal').classList.remove('hidden');
  }
  $('add').addEventListener('click', () => open(null));
  $('cancel').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('save').addEventListener('click', async () => {
    const body = { title: $('fTitle').value, subtitle: $('fSub').value, playbackUrl: $('fUrl').value, logoUrl: $('fLogo').value,
      orientation: $('fOrient').value, accent: $('fAccent').value, background: $('fBg').value, offlineMessage: $('fOff').value };
    try {
      const old = $('fSlugOld').value;
      if (old) await api(`/shows/${old}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/shows', { method: 'POST', body: JSON.stringify({ ...body, slug: $('fSlug').value }) });
      $('modal').classList.add('hidden');
      load();
    } catch (e) { alert(e.message); }
  });

  async function load() {
    try { const r = await api('/shows'); shows = r.shows; base = r.liveBase; $('signin').classList.add('hidden'); render(); } catch { /* signed out */ }
  }
  load();
})();
