// Dynamic poller.
//
// Polls every ENABLED connection's vMix Web API on an interval, classifies the
// result, and pushes state out via a broadcast callback. It re-syncs live off
// the store's 'change' event, so add/edit/remove/enable/reorder take effect
// within ~1s with no restart.

import { fetchVmixApi, parseVmixXml, VmixError } from './vmix.js';

const POLL_MS = 750;
const TIMEOUT_MS = 2000;

export class Poller {
  /**
   * @param {import('./store.js').ConnectionStore} store
   * @param {(msg: object) => void} broadcast  receives state/streams messages
   */
  constructor(store, broadcast) {
    this.store = store;
    this.broadcast = broadcast;
    this.states = new Map(); // id -> latest state snapshot
    this._inflight = new Set();
    this._timer = null;

    this._onChange = () => this._syncStreams();
    store.on('change', this._onChange);
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), POLL_MS);
    this._tick();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.store.off('change', this._onChange);
  }

  // Drop states for connections that no longer exist, then announce the list.
  _syncStreams() {
    const ids = new Set(this.store.list().map((c) => c.id));
    for (const id of this.states.keys()) {
      if (!ids.has(id)) this.states.delete(id);
    }
    this.broadcast({ type: 'streams', streams: this.publicStreams() });
    this._tick();
  }

  publicStreams() {
    return this.store.enabled().map((c) => ({
      id: c.id,
      label: c.label,
      color: c.color,
      warnSeconds: c.warnSeconds,
      dangerSeconds: c.dangerSeconds,
      order: c.order,
    }));
  }

  snapshot() {
    return Object.fromEntries(this.states);
  }

  getState(id) {
    return this.states.get(id) ?? null;
  }

  _tick() {
    for (const conn of this.store.enabled()) {
      if (this._inflight.has(conn.id)) continue;
      this._inflight.add(conn.id);
      this._pollOne(conn).finally(() => this._inflight.delete(conn.id));
    }
  }

  async _pollOne(conn) {
    const ts = Date.now();
    try {
      const xml = await fetchVmixApi(conn.host, conn.port, {
        username: conn.username,
        password: conn.password,
        timeoutMs: TIMEOUT_MS,
      });
      const parsed = parseVmixXml(xml, conn.input);
      const current = parsed.list.find((i) => i.selected) ?? null;
      const state = {
        id: conn.id,
        ts,
        reachable: true,
        authOk: true,
        inputFound: parsed.inputFound,
        vmixState: parsed.state,
        remainingMs: parsed.remainingMs,
        duration: parsed.duration,
        position: parsed.position,
        item: current ? current.title : parsed.title,
        list: parsed.list,
        warnSeconds: conn.warnSeconds,
        dangerSeconds: conn.dangerSeconds,
        zone: classify(parsed.remainingMs, conn),
      };
      this._setState(conn.id, state);
    } catch (err) {
      const code = err instanceof VmixError ? err.code : 'ERR';
      const state = {
        id: conn.id,
        ts,
        reachable: code !== 'NETWORK' && code !== 'TIMEOUT' ? true : false,
        authOk: code !== 'AUTH',
        inputFound: false,
        vmixState: 'Offline',
        remainingMs: null,
        item: null,
        list: [],
        warnSeconds: conn.warnSeconds,
        dangerSeconds: conn.dangerSeconds,
        zone: 'offline',
        error: code,
      };
      this._setState(conn.id, state);
    }
  }

  _setState(id, state) {
    this.states.set(id, state);
    this.broadcast({ type: 'state', ...state });
  }
}

// Threshold classification (server-side hint; client also re-derives on tick).
function classify(remainingMs, conn) {
  if (remainingMs == null) return 'idle';
  const s = remainingMs / 1000;
  if (s <= conn.dangerSeconds) return 'danger';
  if (s <= conn.warnSeconds) return 'warn';
  return 'ok';
}
