/* Tiny canvas time-series chart. No dependencies, no build step.
   One y-axis per chart (never dual-axis). 2px lines, recessive grid, nulls
   break the line, crosshair + tooltip on hover, legend for >= 2 series.
   Usage: const c = GFChart(el, { title, unit, series:[{key,label,color}], type:'line'|'bar', min, max, fmt });
          c.update(points, windowMs) */
(function () {
  const INK = '#B8B8BE';
  const GRID = 'rgba(255,255,255,0.08)';
  const SURFACE = '#0A0A0C';

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  function fmtClock(t) {
    const d = new Date(t);
    return d.toTimeString().slice(0, 8);
  }

  window.GFChart = function (el, opts) {
    const fmt = opts.fmt || ((v) => (v == null ? '—' : String(Math.round(v * 10) / 10)));
    el.classList.add('gfchart');
    el.innerHTML = `
      <div class="gfc-head"><span class="gfc-title">${opts.title}</span>
        <span class="gfc-now"></span></div>
      ${opts.series.length > 1 ? `<div class="gfc-legend">${opts.series.map((s) =>
        `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div>` : ''}
      <div class="gfc-body"><canvas></canvas><div class="gfc-tip hidden"></div></div>`;
    const canvas = el.querySelector('canvas');
    const tip = el.querySelector('.gfc-tip');
    const nowEl = el.querySelector('.gfc-now');
    let pts = [];
    let win = 15 * 60 * 1000;
    let hoverX = null;
    let geom = null;

    function value(p, key) {
      const v = typeof key === 'function' ? key(p) : p[key];
      return v == null || !Number.isFinite(v) ? null : v;
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const padL = 44; const padR = 8; const padT = 6; const padB = 18;
      const tMax = pts.length ? pts[pts.length - 1].t : Date.now();
      const tMin = tMax - win;
      const vis = pts.filter((p) => p.t >= tMin);

      let lo = opts.min ?? Infinity; let hi = opts.max ?? -Infinity;
      if (opts.min == null || opts.max == null) {
        for (const p of vis) for (const s of opts.series) {
          const v = value(p, s.key);
          if (v == null) continue;
          if (opts.min == null) lo = Math.min(lo, v);
          if (opts.max == null) hi = Math.max(hi, v);
        }
      }
      if (!Number.isFinite(lo)) lo = 0;
      if (!Number.isFinite(hi)) hi = 1;
      if (opts.min == null) lo = Math.min(0, lo);
      if (opts.max == null) hi = niceMax(hi * 1.1);
      if (hi <= lo) hi = lo + 1;

      const X = (t) => padL + ((t - tMin) / win) * (w - padL - padR);
      const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
      geom = { X, Y, tMin, padL, padR, w, h, vis };

      // Grid + y labels (3 lines).
      ctx.font = '11px Poppins, system-ui, sans-serif';
      ctx.fillStyle = INK;
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      for (let i = 0; i <= 2; i += 1) {
        const v = lo + ((hi - lo) * i) / 2;
        const y = Math.round(Y(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(fmt(v), padL - 6, y);
      }
      // x labels: start / end clock.
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left'; ctx.fillText(fmtClock(tMin), padL, h - 4);
      ctx.textAlign = 'right'; ctx.fillText(fmtClock(tMax), w - padR, h - 4);

      if (opts.type === 'bar') {
        const bw = Math.max(1, ((w - padL - padR) / (win / 1000)) - 1);
        for (const s of opts.series) {
          ctx.fillStyle = s.color;
          for (const p of vis) {
            const v = value(p, s.key);
            if (!v) continue;
            const x = X(p.t); const y = Y(v);
            ctx.fillRect(x - bw / 2, y, bw, Y(lo) - y);
          }
        }
      } else {
        ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        for (const s of opts.series) {
          ctx.strokeStyle = s.color;
          ctx.beginPath();
          let pen = false; let prevT = null;
          for (const p of vis) {
            const v = value(p, s.key);
            // Break the line on missing values or gaps in the timeline.
            if (v == null || (prevT != null && p.t - prevT > 2500)) { pen = false; }
            if (v != null) {
              const x = X(p.t); const y = Y(Math.max(lo, Math.min(hi, v)));
              if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
              pen = true;
            }
            prevT = p.t;
          }
          ctx.stroke();
        }
      }

      // Crosshair.
      if (hoverX != null && vis.length) {
        const t = tMin + ((hoverX - padL) / (w - padL - padR)) * win;
        let best = vis[0];
        for (const p of vis) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
        const x = Math.round(X(best.t)) + 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
        for (const s of opts.series) {
          const v = value(best, s.key);
          if (v == null || opts.type === 'bar') continue;
          ctx.fillStyle = s.color; ctx.strokeStyle = SURFACE; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, Y(Math.max(lo, Math.min(hi, v))), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        tip.innerHTML = `<b>${fmtClock(best.t)}</b>` + opts.series.map((s) =>
          `<div><i style="background:${s.color}"></i>${s.label}: ${fmt(value(best, s.key))}${value(best, s.key) == null ? '' : ' ' + (opts.unit || '')}</div>`).join('');
        tip.classList.remove('hidden');
        const left = Math.min(Math.max(0, x + 10), w - tip.offsetWidth - 4);
        tip.style.left = (x + tip.offsetWidth + 14 > w ? x - tip.offsetWidth - 10 : left) + 'px';
      } else {
        tip.classList.add('hidden');
      }

      // Current value in the header.
      const last = pts[pts.length - 1];
      nowEl.textContent = last ? opts.series.map((s) => {
        const v = value(last, s.key);
        return `${opts.series.length > 1 ? s.label + ' ' : ''}${fmt(v)}${v == null ? '' : ' ' + (opts.unit || '')}`;
      }).join('  ·  ') : '';
    }

    canvas.addEventListener('mousemove', (e) => { hoverX = e.offsetX; draw(); });
    canvas.addEventListener('mouseleave', () => { hoverX = null; draw(); });
    window.addEventListener('resize', draw);

    return {
      update(points, windowMs) { pts = points; if (windowMs) win = windowMs; draw(); },
    };
  };
})();
