// Cloudflare tunnel manager.
//
// Wraps the `cloudflared` npm package, which manages the binary. Two modes:
//   - named (production): `cloudflared tunnel run --token <TOKEN>`, publishing
//     producer views at the fixed hostname https://liveproducers.glassfire.co.
//   - quick  (testing): `cloudflared tunnel --url http://localhost:<port>`,
//     which prints an ephemeral *.trycloudflare.com URL.
//
// We spawn the bundled binary directly (via cloudflared's `bin` path) for full
// control over args, auto-retry with backoff on crash, and a clean stop.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { bin, install } from 'cloudflared';
import { TUNNEL_HOSTNAME } from './settings.js';

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

export class TunnelManager extends EventEmitter {
  /** @param {() => object} getConfig  returns { mode, token, hostname } */
  constructor(getConfig, port) {
    super();
    this.getConfig = getConfig;
    this.port = port;
    this.child = null;
    this.status = 'stopped'; // stopped|installing|starting|connected|retrying|error
    this.mode = null;
    this.quickUrl = null;
    this.lastError = null;
    this._wantRunning = false;
    this._retries = 0;
    this._retryTimer = null;
  }

  _set(status, extra = {}) {
    this.status = status;
    Object.assign(this, extra);
    this.emit('status', this.state());
  }

  state() {
    const cfg = this.getConfig();
    const mode = this.mode ?? cfg.mode;
    const baseUrl = mode === 'quick' ? this.quickUrl : `https://${cfg.hostname || TUNNEL_HOSTNAME}`;
    return {
      status: this.status,
      mode,
      running: this._wantRunning,
      baseUrl: baseUrl || null,
      hostname: cfg.hostname || TUNNEL_HOSTNAME,
      tokenSet: !!cfg.token,
      lastError: this.lastError,
    };
  }

  async _ensureBinary() {
    if (existsSync(bin)) return;
    this._set('installing');
    await install(bin);
  }

  async start() {
    this._wantRunning = true;
    this._retries = 0;
    await this._spawn();
  }

  async _spawn() {
    if (!this._wantRunning) return;
    const cfg = this.getConfig();
    const useNamed = cfg.mode === 'named' && cfg.token;
    this.mode = useNamed ? 'named' : 'quick';

    try {
      await this._ensureBinary();
    } catch (err) {
      this.lastError = `binary install failed: ${err.message}`;
      this._set('error');
      this._scheduleRetry();
      return;
    }

    const args = useNamed
      ? ['tunnel', '--no-autoupdate', 'run', '--token', cfg.token]
      : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${this.port}`];

    this._set('starting', { quickUrl: useNamed ? null : this.quickUrl });

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    const onData = (buf) => {
      const text = buf.toString();
      if (!useNamed) {
        const m = text.match(TRYCLOUDFLARE_RE);
        if (m && this.quickUrl !== m[0]) {
          this.quickUrl = m[0];
          this._set('connected', { quickUrl: m[0] });
        }
      }
      // cloudflared logs "Registered tunnel connection" once connected.
      if (/Registered tunnel connection|Connection .* registered/i.test(text)) {
        this._retries = 0;
        if (this.status !== 'connected') this._set('connected');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('exit', (code, signal) => {
      this.child = null;
      if (!this._wantRunning) {
        this._set('stopped');
        return;
      }
      this.lastError = `cloudflared exited (code=${code} signal=${signal})`;
      this._scheduleRetry();
    });

    child.on('error', (err) => {
      this.lastError = err.message;
      this._set('error');
    });
  }

  _scheduleRetry() {
    if (!this._wantRunning) return;
    const delay = BACKOFF_MS[Math.min(this._retries, BACKOFF_MS.length - 1)];
    this._retries += 1;
    this._set('retrying');
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._spawn(), delay);
  }

  async stop() {
    this._wantRunning = false;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    if (this.child) {
      const child = this.child;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    this.child = null;
    this._set('stopped');
  }
}
