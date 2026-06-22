// Settings store — data/settings.json (gitignored).
//
// Holds secrets and runtime config that are NOT connection records:
//   - admin password hash (never the plaintext)
//   - session signing secret
//   - optional producer access token
//   - tunnel config { mode: "named"|"quick", token, hostname }
//
// Atomic writes, same as the connection store.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.resolve('data');
const FILE = path.join(DATA_DIR, 'settings.json');

export const TUNNEL_HOSTNAME = 'liveproducers.glassfire.co';
export const PRODUCER_PORT_DEFAULT = 8090;

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: scryptHash(password, salt) };
}

export function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const candidate = scryptHash(password, record.salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class Settings {
  constructor() {
    this.data = null;
    /** When we auto-generate an admin password, expose it once for SETUP.md. */
    this.generatedAdminPassword = null;
  }

  async load() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      this.data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = {};
    }

    let dirty = false;

    if (!this.data.sessionSecret) {
      this.data.sessionSecret = crypto.randomBytes(32).toString('hex');
      dirty = true;
    }

    // Admin password: prefer ADMIN_PASSWORD env; else generate once.
    const envPw = process.env.ADMIN_PASSWORD;
    if (envPw) {
      // Always track the env password's hash so login works without storing plaintext.
      const needsRehash = !this.data.admin || !verifyPassword(envPw, this.data.admin);
      if (needsRehash) {
        this.data.admin = { ...hashPassword(envPw), source: 'env' };
        dirty = true;
      }
    } else if (!this.data.admin) {
      const pw = crypto.randomBytes(12).toString('base64url');
      this.data.admin = { ...hashPassword(pw), source: 'generated' };
      this.generatedAdminPassword = pw;
      dirty = true;
    }

    if (!this.data.producer) {
      this.data.producer = { token: '' };
      dirty = true;
    }

    if (!this.data.tunnel) {
      this.data.tunnel = { mode: 'named', token: '', hostname: TUNNEL_HOSTNAME };
      dirty = true;
    }
    if (!this.data.tunnel.hostname) {
      this.data.tunnel.hostname = TUNNEL_HOSTNAME;
      dirty = true;
    }

    if (dirty) await this._persist();
    return this.data;
  }

  async _persist() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(tmp, FILE);
  }

  // ---- accessors ----------------------------------------------------------
  get sessionSecret() { return this.data.sessionSecret; }
  get producerToken() { return this.data.producer?.token || ''; }
  get tunnel() { return this.data.tunnel; }

  verifyAdmin(password) {
    return verifyPassword(password, this.data.admin);
  }

  async setProducerToken(token) {
    this.data.producer.token = String(token ?? '');
    await this._persist();
  }

  async setAdminPassword(password) {
    this.data.admin = { ...hashPassword(password), source: 'user' };
    await this._persist();
  }

  async setTunnel(patch) {
    this.data.tunnel = { ...this.data.tunnel, ...patch };
    if (!this.data.tunnel.hostname) this.data.tunnel.hostname = TUNNEL_HOSTNAME;
    await this._persist();
    return this.data.tunnel;
  }

  // Safe projection for the admin UI (never returns secrets verbatim).
  publicSettings() {
    return {
      producerTokenSet: !!this.producerToken,
      tunnel: {
        mode: this.data.tunnel.mode,
        hostname: this.data.tunnel.hostname,
        tokenSet: !!this.data.tunnel.token,
      },
    };
  }
}
