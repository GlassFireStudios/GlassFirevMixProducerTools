/* Guest join flow: welcome → browser → camera/mic → sound → connection → join.
   Reports progress to the producer, then hands off to vmixcall.com. */
(function () {
  const $ = (id) => document.getElementById(id);
  const code = decodeURIComponent(location.pathname.replace(/^\/join\//, ''));
  const report = { browser: null, camera: null, mic: null, headphones: null, heardChime: null, net: null };
  let stream = null;
  let audioCtx = null;
  let meterRaf = null;
  let micPeak = 0;
  let invite = null;

  const api = (p, body) => fetch(`/api/join/${encodeURIComponent(code)}${p}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);

  function show(step) {
    document.querySelectorAll('.step').forEach((s) => s.classList.add('hidden'));
    $(`s-${step}`).classList.remove('hidden');
    let past = true;
    document.querySelectorAll('#steps li').forEach((li) => {
      if (li.dataset.s === step) { li.className = 'on'; past = false; } else li.className = past ? 'done' : '';
    });
    window.scrollTo(0, 0);
  }

  function result(el, kind, html) {
    el.className = `result ${kind}`;
    el.innerHTML = html;
  }

  // ---- 1. welcome -------------------------------------------------------------
  async function loadInvite() {
    const r = await fetch(`/api/join/${encodeURIComponent(code)}`).catch(() => null);
    if (!r || !r.ok) {
      $('hello').textContent = 'This link is not valid';
      $('showLine').textContent = 'Check you opened the whole link, or ask the producer to send a new one.';
      $('goBrowser').disabled = true;
      return;
    }
    invite = await r.json();
    $('hello').textContent = invite.guestName && invite.guestName !== 'Guest' ? `Hi ${invite.guestName}` : 'Welcome';
    if (invite.show) $('showLine').textContent = `You've been invited to join ${invite.show}. This takes about two minutes and checks that everything works before you go on.`;
    if (!$('name').value) $('name').value = invite.guestName !== 'Guest' ? invite.guestName : '';
    $('notReady').textContent = invite.ready ? '' : 'Your producer is still setting up your call. You can run the check now.';
  }
  show('welcome');
  loadInvite().then(() => invite && api('/event', { type: 'opened' }));

  $('goBrowser').addEventListener('click', () => {
    if (!$('name').value.trim()) { $('name').focus(); return; }
    checkBrowser();
    show('browser');
  });

  // ---- 2. browser ---------------------------------------------------------------
  function checkBrowser() {
    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const inApp = /FBAN|FBAV|Instagram|Line\/|GSA\/|; wv\)|Twitter|LinkedInApp|Snapchat/i.test(ua);
    const chrome = /Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua);
    const edge = /Edg\//.test(ua);
    const firefox = /Firefox\//.test(ua);
    const safari = /Safari\//.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS/.test(ua);
    const media = !!navigator.mediaDevices?.getUserMedia;
    let kind = 'ok';
    let msg;
    if (inApp) {
      kind = 'bad';
      msg = 'You opened this inside another app (like Gmail, Facebook or Instagram). Video calls don\'t work there.<br><b>Tap the menu (⋯) and choose "Open in browser"</b>, or copy this link into ' + (ios ? 'Safari' : 'Chrome') + '.';
    } else if (!media || !window.isSecureContext) {
      kind = 'bad';
      msg = 'This browser can\'t use your camera. Please open this link in ' + (ios ? 'Safari' : 'Google Chrome') + '.';
    } else if (ios) {
      kind = safari ? 'ok' : 'warn';
      msg = safari ? 'Safari on iPhone/iPad works well.' : 'For the best result on iPhone/iPad, open this link in <b>Safari</b>.';
    } else if (chrome || edge) {
      msg = `${edge ? 'Microsoft Edge' : 'Google Chrome'} works well.`;
    } else if (firefox) {
      kind = 'warn';
      msg = 'Firefox works, but Google Chrome is the most reliable for vMix Call.';
    } else if (safari) {
      kind = 'warn';
      msg = 'Safari on a Mac can have trouble with vMix Call. <b>Google Chrome</b> is recommended.';
    } else {
      kind = 'warn';
      msg = 'We don\'t recognise this browser. Google Chrome is recommended.';
    }
    report.browser = { kind, ua: ua.slice(0, 200) };
    result($('browserResult'), kind, msg);
    $('goAv').disabled = kind === 'bad';
  }
  $('goAv').addEventListener('click', () => { show('av'); startAv(); });

  // ---- 3. camera + mic ------------------------------------------------------------
  async function listDevices() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, current) => {
      sel.innerHTML = devs.filter((d) => d.kind === kind)
        .map((d, i) => `<option value="${d.deviceId}">${(d.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}`).replace(/</g, '&lt;')}</option>`).join('');
      if (current) sel.value = current;
    };
    fill($('camSel'), 'videoinput', stream?.getVideoTracks()[0]?.getSettings().deviceId);
    fill($('micSel'), 'audioinput', stream?.getAudioTracks()[0]?.getSettings().deviceId);
  }

  function stopStream() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function startAv(constraints) {
    stopStream();
    $('avResult').classList.add('hidden');
    $('goSound').disabled = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints || { video: { width: { ideal: 1280 } }, audio: true });
    } catch (e) {
      const denied = e.name === 'NotAllowedError' || e.name === 'SecurityError';
      const missing = e.name === 'NotFoundError' || e.name === 'OverconstrainedError';
      const busy = e.name === 'NotReadableError';
      result($('avResult'), 'bad', denied
        ? 'Camera or microphone access was blocked. Click the <b>camera icon in the address bar</b> (on iPhone: Settings, then Safari, then Camera and Microphone), choose <b>Allow</b>, then press <b>Ask again</b>.'
        : missing ? 'We couldn\'t find a camera or microphone. Check it\'s plugged in, then press <b>Ask again</b>.'
          : busy ? 'Another app is using your camera. Close Zoom, Teams or FaceTime, then press <b>Ask again</b>.'
            : `Something went wrong (${e.name}). Press <b>Ask again</b>.`);
      report.camera = { ok: false, error: e.name };
      return;
    }
    $('preview').srcObject = stream;
    const v = stream.getVideoTracks()[0];
    const s = v?.getSettings() || {};
    report.camera = { ok: !!v, label: v?.label, width: s.width, height: s.height };
    await listDevices();
    startMeter();
  }

  function startMeter() {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    micPeak = 0;
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      micPeak = Math.max(micPeak * 0.995, peak);
      const db = peak > 0 ? 20 * Math.log10(peak) : -100;
      $('micBar').style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
      if (micPeak > 0.05 && $('goSound').disabled) {
        $('goSound').disabled = false;
        $('micHint').textContent = 'Your microphone is working.';
        const a = stream.getAudioTracks()[0];
        report.mic = { ok: true, label: a?.label };
      }
      meterRaf = requestAnimationFrame(loop);
    };
    loop();
    setTimeout(() => {
      if ($('goSound').disabled && stream) {
        $('micHint').textContent = 'We can\'t hear anything yet. Check your mic isn\'t muted, or pick a different one above.';
        $('goSound').disabled = false; // let them continue; producer sees the report
        report.mic = report.mic || { ok: false, label: stream.getAudioTracks()[0]?.label };
      }
    }, 8000);
  }

  $('camSel').addEventListener('change', () => startAv({ video: { deviceId: { exact: $('camSel').value } }, audio: { deviceId: { exact: $('micSel').value } } }));
  $('micSel').addEventListener('change', () => startAv({ video: { deviceId: { exact: $('camSel').value } }, audio: { deviceId: { exact: $('micSel').value } } }));
  $('avRetry').addEventListener('click', () => startAv());
  $('goSound').addEventListener('click', () => show('sound'));

  // ---- 4. sound -----------------------------------------------------------------
  $('playTone').addEventListener('click', () => {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
    const now = audioCtx.currentTime;
    [660, 880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + i * 0.18);
      o.stop(now + i * 0.18 + 0.4);
    });
  });
  document.querySelectorAll('input[name=hp]').forEach((r) => r.addEventListener('change', () => {
    report.headphones = r.value === 'yes';
    result($('hpNote'), report.headphones ? 'ok' : 'warn', report.headphones
      ? 'Great. Headphones stop the show audio echoing back.'
      : 'That\'s okay. Keep your speaker volume low, and the producer may ask you to mute when you\'re not talking.');
  }));
  $('noHear').addEventListener('click', () => {
    report.heardChime = false;
    result($('soundHelp'), 'warn', 'Check your volume is up and the right output is selected (on a computer, click the speaker icon near the clock). Then press <b>Play chime</b> again. You can still continue: the producer will check with you.');
    $('goNet').textContent = 'Continue anyway';
  });
  $('goNet').addEventListener('click', () => {
    if (report.heardChime !== false) report.heardChime = true;
    show('net');
    runNet();
  });

  // ---- 5. network ---------------------------------------------------------------
  async function runNet() {
    $('goReady').disabled = true;
    $('netRetry').classList.add('hidden');
    $('netResult').classList.add('hidden');
    ['dl', 'ul', 'rtt'].forEach((id) => { $(id).textContent = '…'; });
    try {
      const pings = [];
      for (let i = 0; i < 5; i += 1) {
        const t = performance.now();
        await fetch(`/api/join/ping?_=${Math.random()}`, { cache: 'no-store' });
        pings.push(performance.now() - t);
      }
      pings.sort((a, b) => a - b);
      const rtt = Math.round(pings[2]);
      $('rtt').textContent = `${rtt} ms`;

      let t = performance.now();
      const blob = await (await fetch(`/api/join/speed/down?_=${Math.random()}`, { cache: 'no-store' })).arrayBuffer();
      const down = (blob.byteLength * 8) / ((performance.now() - t) / 1000) / 1e6;
      $('dl').textContent = `${down.toFixed(1)} Mbps`;

      const up = new Uint8Array(1024 * 1024);
      crypto.getRandomValues(up.subarray(0, 65536));
      t = performance.now();
      await fetch('/api/join/speed/up', { method: 'POST', body: up, headers: { 'Content-Type': 'application/octet-stream' } });
      const upMbps = (up.byteLength * 8) / ((performance.now() - t) / 1000) / 1e6;
      $('ul').textContent = `${upMbps.toFixed(1)} Mbps`;

      report.net = { downMbps: Math.round(down * 10) / 10, upMbps: Math.round(upMbps * 10) / 10, rttMs: rtt };
      // vMix's guidance: 2 Mbps down / 0.6 Mbps up per guest. Ask for headroom.
      const good = down >= 4 && upMbps >= 1.5 && rtt < 250;
      const ok = down >= 2 && upMbps >= 0.6;
      result($('netResult'), good ? 'ok' : ok ? 'warn' : 'bad', good
        ? 'Your connection looks good.'
        : ok ? 'Your connection should work, but it\'s on the slow side. Move closer to your Wi-Fi router, or plug in a cable, and close anything else using the internet.'
          : 'Your connection is too slow for video right now. Try moving closer to Wi-Fi, using a cable, or your phone on cellular data, then press <b>Test again</b>.');
      $('netRetry').classList.remove('hidden');
      $('goReady').disabled = false;
      $('goReady').textContent = ok ? 'Next' : 'Continue anyway';
    } catch {
      result($('netResult'), 'warn', 'We couldn\'t finish the speed test. You can continue. The producer will check your picture before you go live.');
      $('netRetry').classList.remove('hidden');
      $('goReady').disabled = false;
    }
  }
  $('netRetry').addEventListener('click', runNet);
  $('goReady').addEventListener('click', () => { buildSummary(); show('ready'); api('/event', { type: 'check', details: report }); });

  // ---- 6. ready + join ------------------------------------------------------------
  function buildSummary() {
    const line = (ok, text) => `<li class="${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}">${text}</li>`;
    $('summary').innerHTML = [
      line(report.browser?.kind === 'ok' ? true : report.browser?.kind === 'bad' ? false : null, 'Browser'),
      line(!!report.camera?.ok, `Camera${report.camera?.label ? `: ${report.camera.label.replace(/</g, '&lt;')}` : ''}`),
      line(report.mic?.ok ? true : null, `Microphone${report.mic?.label ? `: ${report.mic.label.replace(/</g, '&lt;')}` : ''}`),
      line(report.heardChime ? true : null, report.heardChime ? 'Sound: heard the chime' : 'Sound: not confirmed'),
      line(report.headphones ? true : null, report.headphones ? 'Wearing headphones' : 'No headphones'),
      line(report.net ? (report.net.downMbps >= 2 && report.net.upMbps >= 0.6 ? true : null) : null,
        report.net ? `Connection: ${report.net.downMbps} down / ${report.net.upMbps} up Mbps` : 'Connection: not tested'),
    ].join('');
  }

  $('joinBtn').addEventListener('click', async () => {
    $('joinBtn').disabled = true;
    $('joinNote').textContent = 'Opening vMix Call…';
    const r = await api('/go', { name: $('name').value.trim(), details: report }).catch(() => null);
    if (!r || !r.ok) {
      $('joinBtn').disabled = false;
      $('joinNote').textContent = r && r.status === 409
        ? 'Your producer hasn\'t opened your call yet. Keep this page open and try again in a minute.'
        : 'Couldn\'t connect. Please try again.';
      return;
    }
    const { url } = await r.json();
    stopStream(); // free the camera so vMix Call can use it
    location.href = url;
  });
})();
