// Tiny signed-cookie session layer for the admin gate.
//
// No external session library: a cookie holds base64url(payload).hmac, where the
// HMAC is keyed by the per-install sessionSecret. Tamper-evident and stateless.

import crypto from 'crypto';

const COOKIE = 'gf_admin';
const TTL_MS = 1000 * 60 * 60 * 12; // 12h

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function issueSession(secret) {
  const payload = { iat: Date.now(), exp: Date.now() + TTL_MS, n: crypto.randomBytes(8).toString('hex') };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64, secret)}`;
}

export function verifySession(token, secret) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const b64 = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(b64, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

export function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Express middleware factory: gate admin/connection/tunnel/settings APIs.
export function requireAdmin(settings) {
  return (req, res, next) => {
    const cookies = parseCookies(req);
    if (verifySession(cookies[COOKIE], settings.sessionSecret)) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}

export function isAdmin(req, settings) {
  const cookies = parseCookies(req);
  return verifySession(cookies[COOKIE], settings.sessionSecret);
}

export { COOKIE as ADMIN_COOKIE };
