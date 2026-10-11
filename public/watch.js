/* White-label watch page: loads the show's look + IVS playback URL, plays it
   with the IVS player (low latency), shows a slate while offline and retries. */
(function () {
  const $ = (id) => document.getElementById(id);
  const slug = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, ''));
  let show = null;
  let player = null;
  let retry = null;

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
    // Browsers only autoplay muted; offer one tap to unmute.
    player.setAutoplay(true);
    player.setMuted(true);
    $('unmute').addEventListener('click', () => { player.setMuted(false); $('unmute').classList.add('hidden'); });
    tryPlay();
  }
  init();
})();
