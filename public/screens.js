/* Screens: every venue screen that ran live.glassfire.co/check, and its verdict. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const DEC = { smooth: ['yes', 'sig-ok'], yes: ['stutters', 'sig-warn'], no: ['no', 'sig-bad'], unknown: ['?', 'muted'] };
  const LEVEL = { '4k': 'sig-ok', '1080p': 'sig-warn', weak: 'sig-bad' };
  let checkUrl = '';

  async function api(p, opts = {}) {
    const res = await fetch('/api/admin' + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 401) { $('signin').classList.remove('hidden'); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  }
  const dec = (v) => { const [t, c] = DEC[v] || DEC.unknown; return `<span class="${c}">${t}</span>`; };
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : new Date(t).toLocaleString(); };
  function device(ua) {
    if (/BrightSign/i.test(ua)) return 'BrightSign';
    if (/AFT\w+|Silk/i.test(ua)) return 'Fire TV';
    if (/Tizen/i.test(ua)) return 'Samsung Tizen';
    if (/Web0S|webOS/i.test(ua)) return 'LG webOS';
    if (/CrKey/i.test(ua)) return 'Chromecast';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Macintosh/i.test(ua)) return 'Mac';
    if (/iPhone|iPad/i.test(ua)) return 'iOS';
    if (/CrOS/i.test(ua)) return 'ChromeOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Unknown';
  }

  function render(checks) {
    const n = (l) => checks.filter((c) => c.verdict?.level === l).length;
    $('summary').innerHTML = checks.length
      ? `<p><b>${checks.length}</b> screens: <span class="sig-ok">${n('4k')} can show 4K</span> · <span class="sig-warn">${n('1080p')} 1080p</span> · <span class="sig-bad">${n('weak')} weak</span></p>` : '';
    $('list').innerHTML = checks.length ? `<table class="conn-table small"><thead><tr>
      <th>Screen</th><th>Verdict</th><th>Pixels</th><th>Player</th><th>1080p</th><th>1080p60</th><th>4K</th><th>4K HEVC</th><th>Down</th><th>Ping</th><th>Live player</th><th>When</th><th></th></tr></thead><tbody>
      ${checks.map((c) => `<tr>
        <td><b>${esc(c.name || c.id)}</b>${c.name ? ` <span class="mono">${esc(c.id)}</span>` : ''}${c.show ? `<div class="muted small">${esc(c.show)}</div>` : ''}</td>
        <td class="${LEVEL[c.verdict?.level] || ''}">${esc(c.verdict?.label)}</td>
        <td class="mono">${c.screenW}×${c.screenH}</td>
        <td title="${esc(c.ua)}">${esc(device(c.ua))}</td>
        <td>${dec(c.decode?.h264_1080p30)}</td><td>${dec(c.decode?.h264_1080p60)}</td>
        <td>${dec(c.decode?.h264_2160p30)}</td><td>${dec(c.decode?.hevc_2160p30)}</td>
        <td class="mono">${c.downMbps ?? '?'} Mbps</td><td class="mono">${c.pingMs ?? '?'} ms</td>
        <td>${c.ivs ? '<span class="sig-ok">yes</span>' : '<span class="sig-bad">no</span>'}</td>
        <td class="muted">${ago(c.at)}</td>
        <td><button class="btn small secondary" data-del="${esc(c.id)}">Remove</button></td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">No screens have run the check yet.</p>';
    $('list').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { await api(`/screen-checks/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); load(); }));
  }

  async function load() {
    try {
      const r = await api('/screen-checks');
      checkUrl = r.checkUrl;
      $('link').textContent = checkUrl.replace(/^https:\/\//, '');
      $('signin').classList.add('hidden');
      render(r.checks);
    } catch { /* signed out */ }
  }
  $('copy').addEventListener('click', () => { navigator.clipboard?.writeText(checkUrl); $('copy').textContent = 'Copied'; setTimeout(() => ($('copy').textContent = 'Copy check link'), 1200); });
  $('clear').addEventListener('click', async () => { if (confirm('Clear every screen check?')) { await api('/screen-checks', { method: 'DELETE' }); load(); } });
  load();
  setInterval(load, 10000);
})();
