/* White-label watch page: loads the show's look + IVS playback URL, plays it
   with the IVS player (low latency), shows a slate while offline and retries.
   On-screen controls let an on-site tech rotate the picture for however the
   screen is mounted and go true full screen (Esc, or the button, exits). */
(function () {
  const $ = (id) => document.getElementById(id);
  const slug = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''));
  const q = new URLSearchParams(location.search);
  const forcedTv = q.has('tv');
  let rot = [90, 180, 270].includes(Number(q.get('rotate'))) ? Number(q.get('rotate')) : 0;
  let show = null;
  let player = null;
  let retry = null;

  // ---- screen mode: rotation + full screen ---------------------------------------
  const inFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  function applyScreen() {
    const tv = forcedTv || rot !== 0 || inFullscreen();
    document.body.classList.toggle('tv', tv);
    document.body.classList.toggle('sideways', rot === 90 || rot === 270);
    document.body.classList.toggle('cover', q.get('fit') === 'cover');
    document.documentElement.style.setProperty('--rot', `${rot}deg`);
    if (tv) $('video').removeAttribute('controls'); else $('video').setAttribute('controls', '');
    document.querySelectorAll('[data-rot]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rot) === rot)));
    $('fsBtn').textContent = inFullscreen() ? 'Exit full screen' : 'Full screen';
  }

  function setRotation(r) {
    rot = r;
    // Keep the choice in the link, so a reload (or a copied link) keeps it.
    const u = new URL(location.href);
    if (r) u.searchParams.set('rotate', String(r)); else u.searchParams.delete('rotate');
    history.replaceState(null, '', u);
    applyScreen();
  }

  async function toggleFullscreen() {
    try {
      if (inFullscreen()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else await (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen).call(document.documentElement);
    } catch { /* browser refused (e.g. not from a click); nothing to do */ }
  }

  document.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', () => setRotation(Number(b.dataset.rot))));
  $('fsBtn').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', applyScreen);
  document.addEventListener('webkitfullscreenchange', applyScreen);
  // Double-click anywhere on the picture toggles full screen too.
  document.querySelector('.stage').addEventListener('dblclick', toggleFullscreen);

  // Controls + cursor appear on any movement or tap, fade after 3s idle.
  let idleTimer = null;
  function wakeControls() {
    $('controls').classList.remove('idle');
    document.body.classList.remove('idle-cursor');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if ($('controls').matches(':hover') || $('controls').contains(document.activeElement)) return wakeControls();
      $('controls').classList.add('idle');
      document.body.classList.add('idle-cursor');
    }, 3000);
  }
  ['mousemove', 'mousedown', 'touchstart', 'keydown'].forEach((e) => document.addEventListener(e, wakeControls, { passive: true }));
  wakeControls();

  // Keep the screen awake (supported browsers only).
  const wake = () => navigator.wakeLock?.request('screen').catch(() => {});
  wake();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });

  applyScreen();

  // ---- playback ---------------------------------------------------------------------
  function setLive(on) {
    $('liveTag').textContent = on ? 'LIVE' : 'OFFLINE';
    $('liveTag').classList.toggle('on', on);
    $('slate').classList.toggle('hidden', on);
  }

  function tryPlay() {
    clearTimeout(retry);
    if (!show?.playbackUrl) { $('slate').textContent = show?.offlineMessage || 'The stream will begin shortly.'; return; }
    player.load(show.playbackUrl);
    player.play();
  }

  async function init() {
    const r = await fetch(`/api/show/${encodeURIComponent(slug)}`).catch(() => null);
    if (!r || !r.ok) { $('slate').textContent = 'This stream could not be found.'; return; }
    show = await r.json();
    document.title = show.title;
    document.body.classList.toggle('vertical', show.orientation === 'vertical');
    document.documentElement.style.setProperty('--accent', show.accent);
    document.documentElement.style.setProperty('--bg', show.background);
    $('title').textContent = show.title;
    $('subtitle').textContent = show.subtitle;
    if (show.logoUrl) { $('logo').src = show.logoUrl; $('logo').classList.remove('hidden'); }
    $('slate').textContent = show.offlineMessage;

    if (!window.IVSPlayer || !IVSPlayer.isPlayerSupported) { $('slate').textContent = 'Your browser cannot play this stream. Please try Chrome, Edge, Safari or Firefox.'; return; }
    player = IVSPlayer.create();
    player.attachHTMLVideoElement($('video'));
    const S = IVSPlayer.PlayerState;
    const E = IVSPlayer.PlayerEventType;
    player.addEventListener(S.PLAYING, () => {
      setLive(true);
      $('unmute').classList.toggle('hidden', !player.isMuted());
    });
    player.addEventListener(S.ENDED, () => { setLive(false); retry = setTimeout(tryPlay, 10000); });
    // Not live yet (or a blip): keep the slate up and retry quietly.
    player.addEventListener(E.ERROR, () => { setLive(false); retry = setTimeout(tryPlay, 10000); });
    // Browsers only autoplay muted; offer one tap to unmute (?sound=1 tries with sound).
    player.setAutoplay(true);
    player.setMuted(q.get('sound') !== '1');
    $('unmute').addEventListener('click', () => { player.setMuted(false); $('unmute').classList.add('hidden'); });
    tryPlay();
  }
  init();
})();
