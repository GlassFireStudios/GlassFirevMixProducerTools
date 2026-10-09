/* Card rendering + switcher bar, shared by index.html and grid.html. */
(function () {
  const GF = window.GF;

  // Build/refresh the switcher bar. activeId highlights one (stream view).
  GF.renderSwitcher = function (el, streams, states, activeId) {
    const frag = document.createDocumentFragment();

    const brand = document.createElement('a');
    brand.href = '/';
    brand.className = 'brand';
    brand.innerHTML = '<img class="brand-mark" src="/brand/livetools-icon.svg" alt="" width="24" height="24" /> GlassFire <small>Live Tools</small>';
    frag.appendChild(brand);

    streams.forEach((s, i) => {
      const a = document.createElement('a');
      const zone = GF.zoneFor(states[s.id]);
      a.className = 'switch-btn zone-' + zone + (s.id === activeId ? ' active' : '');
      a.href = GF.withToken('/s/' + encodeURIComponent(s.id));
      const key = i < 9 ? `<span class="key">${i + 1}</span>` : '';
      a.innerHTML = `<span class="dot"></span><span>${esc(s.label)}</span>${key}`;
      frag.appendChild(a);
    });

    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    frag.appendChild(spacer);

    const grid = document.createElement('a');
    grid.className = 'switch-btn';
    grid.href = GF.withToken('/grid.html');
    grid.textContent = 'Grid';
    frag.appendChild(grid);

    el.replaceChildren(frag);
  };

  // Render the overview/grid of cards.
  GF.renderCards = function (el, streams, states) {
    if (!streams.length) {
      el.innerHTML = '<div class="empty">No streams configured yet. Add vMix connections in <a href="/admin">/admin</a>.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    streams.forEach((s) => {
      const st = states[s.id];
      const zone = GF.zoneFor(st);
      const a = document.createElement('a');
      a.className = 'card zone-' + zone;
      a.href = GF.withToken('/s/' + encodeURIComponent(s.id));
      a.dataset.id = s.id;
      a.innerHTML = `
        <div class="top"><span class="swatch" style="background:${esc(s.color)}"></span><span class="name">${esc(s.label)}</span></div>
        <div class="big" data-time>--:--</div>
        <div class="sub" data-sub></div>`;
      frag.appendChild(a);
    });
    el.replaceChildren(frag);
  };

  // Per-frame refresh of card times (smooth interpolation).
  GF.tickCards = function (el, streams, states) {
    streams.forEach((s) => {
      const card = el.querySelector(`.card[data-id="${cssEsc(s.id)}"]`);
      if (!card) return;
      const st = states[s.id];
      const zone = GF.zoneFor(st);
      card.className = 'card zone-' + zone;
      const t = card.querySelector('[data-time]');
      const sub = card.querySelector('[data-sub]');
      if (!st || !st.reachable) {
        t.textContent = '--:--';
        sub.textContent = st && st.error ? 'offline · ' + st.error : 'offline';
        return;
      }
      const ms = GF.currentRemaining(st);
      t.textContent = ms == null ? '--:--' : GF.fmtTime(ms);
      sub.innerHTML = st.item ? 'Now: <b>' + esc(st.item) + '</b>' : (st.vmixState || '');
    });
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function cssEsc(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }
  GF.esc = esc;
})();
