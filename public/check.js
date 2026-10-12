/* Screen check: works out what this screen/player can really play (resolution,
   1080p and 4K decode, network speed) and reports it to GlassFire. Written in
   plain ES2017 so older smart-TV and signage browsers can run it. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  var show = (q.get('show') || '').replace(/[^\w-]/g, '').slice(0, 60);

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* storage blocked */ }
    return null;
  }
  // A short code per screen, kept across reloads so a re-run updates the same row.
  var id = store('gfScreenId');
  if (!id) {
    var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    id = '';
    for (var i = 0; i < 4; i++) id += abc[Math.floor(Math.random() * abc.length)];
    store('gfScreenId', id);
  }
  $('code').textContent = id;
  $('name').value = q.get('name') || store('gfScreenName') || '';

  var results = {};
  function card(k, v, cls) { return '<div class="card"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>'; }
  var DECODE_LABEL = { smooth: 'Yes, smooth', yes: 'Yes (may stutter)', no: 'No', unknown: 'Unknown' };
  var DECODE_CLS = { smooth: 'yes', yes: 'maybe', no: 'no', unknown: 'maybe' };
  function render() {
    var r = results, d = r.decode || {}, h = '';
    h += card('Screen (physical pixels)', r.screenW ? r.screenW + ' × ' + r.screenH : '…');
    h += card('Browser window', r.viewW ? r.viewW + ' × ' + r.viewH + ' @' + r.dpr + 'x' : '…');
    h += card('1080p video', d.h264_1080p30 ? DECODE_LABEL[d.h264_1080p30] : '…', DECODE_CLS[d.h264_1080p30]);
    h += card('1080p 60fps', d.h264_1080p60 ? DECODE_LABEL[d.h264_1080p60] : '…', DECODE_CLS[d.h264_1080p60]);
    h += card('4K video', d.h264_2160p30 ? DECODE_LABEL[d.h264_2160p30] : '…', DECODE_CLS[d.h264_2160p30]);
    h += card('4K HEVC', d.hevc_2160p30 ? DECODE_LABEL[d.hevc_2160p30] : '…', DECODE_CLS[d.hevc_2160p30]);
    h += card('Download speed', r.downMbps != null ? r.downMbps + ' Mbps' : '…', r.downMbps == null ? '' : r.downMbps >= 25 ? 'yes' : r.downMbps >= 8 ? 'maybe' : 'no');
    h += card('Latency', r.pingMs != null ? r.pingMs + ' ms' : '…');
    h += card('Live player', r.ivs == null ? '…' : r.ivs ? 'Supported' : 'Not supported', r.ivs ? 'yes' : 'no');
    $('grid').innerHTML = h;
  }

  // Same verdict rules as the server (src/screenchecks.js).
  function verdict(r) {
    var long = Math.max(r.screenW || 0, r.screenH || 0), d = r.decode || {}, mbps = r.downMbps || 0;
    var ok = function (k) { return d[k] === 'smooth' || d[k] === 'yes'; };
    if (long >= 3800 && ok('h264_2160p30') && mbps >= 25) return { cls: 'k4', label: 'Can show 4K' };
    if (ok('h264_1080p30') && mbps >= 8) {
      var why = long < 3800 ? 'this screen is not 4K' : !ok('h264_2160p30') ? 'this player cannot decode 4K' : 'the network is too slow for 4K';
      return { cls: 'p1080', label: '1080p', sub: 'Good for 1080p. Not 4K: ' + why + '.' };
    }
    return { cls: 'weak', label: 'Weak', sub: !ok('h264_1080p30') ? 'This player cannot decode 1080p video.' : 'Network is slow (' + mbps + ' Mbps).' };
  }

  async function decode(contentType, w, hgt, fps, bitrate) {
    var cfg = { type: 'media-source', video: { contentType: contentType, width: w, height: hgt, framerate: fps, bitrate: bitrate } };
    try {
      if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
        var info = await navigator.mediaCapabilities.decodingInfo(cfg);
        return info.supported ? (info.smooth ? 'smooth' : 'yes') : 'no';
      }
    } catch (e) { /* fall through */ }
    try { if (window.MediaSource) return MediaSource.isTypeSupported(contentType) ? 'yes' : 'no'; } catch (e) { /* ignore */ }
    return 'unknown';
  }

  async function speed() {
    // Small warm-up sample, then a bigger one sized so it takes a few seconds.
    async function pull(mb) {
      var t0 = performance.now();
      var res = await fetch('/api/check/down?mb=' + mb + '&r=' + Math.random(), { cache: 'no-store' });
      var buf = await res.arrayBuffer();
      var secs = (performance.now() - t0) / 1000;
      return (buf.byteLength * 8) / secs / 1e6;
    }
    var first = await pull(2);
    var big = first > 200 ? 32 : first > 50 ? 16 : first > 10 ? 8 : 0;
    var mbps = big ? await pull(big) : first;
    return Math.round(Math.max(first, mbps) * 10) / 10;
  }

  async function ping() {
    var best = Infinity;
    for (var i = 0; i < 5; i++) {
      var t0 = performance.now();
      try { await fetch('/api/check/ping?r=' + Math.random(), { cache: 'no-store' }); best = Math.min(best, performance.now() - t0); } catch (e) { /* ignore */ }
    }
    return best === Infinity ? null : Math.round(best);
  }

  function ivsReady() {
    return new Promise(function (resolve) {
      var tries = 0;
      (function check() {
        if (window.IVSPlayer) return resolve(!!IVSPlayer.isPlayerSupported);
        if (++tries > 50) return resolve(false);
        setTimeout(check, 100);
      })();
    });
  }

  async function report() {
    var body = Object.assign({ id: id, name: $('name').value.trim(), show: show, ua: navigator.userAgent }, results);
    try {
      var r = await fetch('/api/check/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      $('status').textContent = r.ok ? 'Results sent to GlassFire. Screen code ' + id + '.' : 'Could not send results (' + r.status + ').';
    } catch (e) { $('status').textContent = 'Could not send results: no connection to GlassFire.'; }
  }

  var running = false;
  async function run() {
    if (running) return;
    running = true;
    results = {};
    $('verdict').className = 'verdict';
    $('verdict').textContent = 'Checking…';
    $('verdictSub').textContent = '';
    $('status').textContent = '';
    var dpr = window.devicePixelRatio || 1;
    results.screenW = Math.round(screen.width * dpr);
    results.screenH = Math.round(screen.height * dpr);
    results.viewW = window.innerWidth; results.viewH = window.innerHeight; results.dpr = Math.round(dpr * 100) / 100;
    results.mse = !!window.MediaSource;
    render();
    results.decode = {
      h264_1080p30: await decode('video/mp4; codecs="avc1.640028"', 1920, 1080, 30, 6e6),
      h264_1080p60: await decode('video/mp4; codecs="avc1.64002A"', 1920, 1080, 60, 9e6),
      h264_2160p30: await decode('video/mp4; codecs="avc1.640033"', 3840, 2160, 30, 20e6),
      h264_2160p60: await decode('video/mp4; codecs="avc1.640034"', 3840, 2160, 60, 35e6),
      hevc_2160p30: await decode('video/mp4; codecs="hvc1.1.6.L153.B0"', 3840, 2160, 30, 15e6),
    };
    render();
    $('status').textContent = 'Testing the network…';
    results.pingMs = await ping();
    try { results.downMbps = await speed(); } catch (e) { results.downMbps = 0; }
    results.ivs = await ivsReady();
    render();
    var v = verdict(results);
    $('verdict').className = 'verdict ' + v.cls;
    $('verdict').textContent = v.label;
    $('verdictSub').textContent = v.sub || 'This screen can play the live stream in 4K.';
    await report();
    running = false;
  }

  $('save').addEventListener('click', function () { store('gfScreenName', $('name').value.trim()); report(); });
  $('again').addEventListener('click', run);
  render();
  run();
})();
