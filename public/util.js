/* Shared producer-view helpers. Plain browser script, no build step.
   Exposes a global `GF`. */
(function () {
  const GF = {};

  // Producer access token from ?k=… is carried onto every API call + the WS.
  const params = new URLSearchParams(location.search);
  GF.token = params.get('k') || '';

  GF.withToken = function (path) {
    if (!GF.token) return path;
    return path + (path.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(GF.token);
  };

  // mm:ss (or h:mm:ss for long) from milliseconds.
  GF.fmtTime = function (ms) {
    if (ms == null || Number.isNaN(ms)) return '--:--';
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  };

  // Live remaining time, interpolated from the last update timestamp.
  GF.currentRemaining = function (state) {
    if (!state || state.remainingMs == null) return null;
    if (state.vmixState === 'Running') {
      return Math.max(0, state.remainingMs - (Date.now() - state.ts));
    }
    return state.remainingMs;
  };

  // ok | warn | danger | idle | offline
  GF.zoneFor = function (state) {
    if (!state || !state.reachable) return 'offline';
    const ms = GF.currentRemaining(state);
    if (ms == null) return 'idle';
    const s = ms / 1000;
    if (s <= (state.dangerSeconds ?? 10)) return 'danger';
    if (s <= (state.warnSeconds ?? 30)) return 'warn';
    return 'ok';
  };

  // Reconnecting WebSocket. onMsg(parsedMessage). Returns a small controller.
  GF.connectWS = function (onMsg, onStatus) {
    let ws = null;
    let closed = false;
    let backoff = 500;

    function open() {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws` + (GF.token ? `?k=${encodeURIComponent(GF.token)}` : '');
      ws = new WebSocket(url);
      ws.onopen = () => { backoff = 500; onStatus && onStatus('connected'); };
      ws.onmessage = (ev) => {
        try { onMsg(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
      };
      ws.onclose = () => {
        onStatus && onStatus('disconnected');
        if (closed) return;
        setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 8000);
      };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    }
    open();
    return { close() { closed = true; if (ws) ws.close(); } };
  };

  // Tiny live store of stream states, kept fresh by WS messages.
  GF.Store = function () {
    const streams = [];
    const states = {};
    const listeners = new Set();
    function emit() { listeners.forEach((fn) => fn(streams, states)); }
    return {
      streams, states,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      handle(msg) {
        if (msg.type === 'hello' || msg.type === 'streams') {
          streams.length = 0;
          (msg.streams || []).forEach((s) => streams.push(s));
          if (msg.states) Object.assign(states, msg.states);
          emit();
        } else if (msg.type === 'state') {
          states[msg.id] = msg;
          emit();
        }
      },
    };
  };

  window.GF = GF;
})();
