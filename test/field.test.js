import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrollCode, safeKitPath, isExpired, manifestFor } from '../src/field.js';

const kit = {
  kit: 'k', version: 'v1', root: 'C:\\Show', startup: { H: 'vMix/H.vmix', V: 'vMix/V.vmix' },
  files: [
    { path: 'vMix/H.vmix', stored: 'vMix/H.vmix', role: 'H', apply: 'preset', sha256: 'a', size: 1 },
    { path: 'vMix/V.vmix', stored: 'vMix/V.vmix', role: 'V', apply: 'preset', sha256: 'b', size: 1 },
    { path: 'Countdown/countdown.html', stored: 'Countdown/countdown.html', role: 'all', apply: 'countdown', sha256: 'c', size: 1 },
    { path: 'vMix/AutoSwitch.txt', stored: 'vMix/AutoSwitch.txt.H', role: 'H', sha256: 'd', size: 1 },
  ],
  media: [{ path: 'Loops/h.mp4', role: 'H', sha256: 'e', size: 9 }, { path: 'Bugs/b.png', role: 'all', sha256: 'f', size: 9 }],
};

test('enroll codes look like ABCD-EFGH and avoid look-alike characters', () => {
  for (let i = 0; i < 50; i++) assert.match(enrollCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

test('kit paths cannot escape the kit folder', () => {
  assert.equal(safeKitPath('vMix/H.vmix'), 'vMix/H.vmix');
  assert.equal(safeKitPath('vMix\\H.vmix'), 'vMix/H.vmix');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/x', 'c:\\x', '']) assert.equal(safeKitPath(bad), null, bad);
});

test('licence: expiry date and revoke both end it', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  assert.equal(isExpired({ expiresAt: '2026-10-25T03:59:00Z' }, now), true);
  assert.equal(isExpired({ expiresAt: '2026-10-26T00:00:00Z' }, now), false);
  assert.equal(isExpired({ expiresAt: '' }, now), false);
  assert.equal(isExpired({ expiresAt: '2030-01-01T00:00:00Z', revoked: true }, now), true);
});

test('a machine sees only its role, never stored paths', () => {
  const h = manifestFor(kit, { id: '1', name: 'H', role: 'H', expiresAt: '' });
  assert.deepEqual(h.files.map((f) => f.path).sort(), ['Countdown/countdown.html', 'vMix/AutoSwitch.txt', 'vMix/H.vmix']);
  assert.ok(h.files.every((f) => !('stored' in f) && f.owned === true));
  assert.deepEqual(h.media.map((f) => f.path).sort(), ['Bugs/b.png', 'Loops/h.mp4']);
  assert.equal(h.startup, 'vMix/H.vmix');
  const v = manifestFor(kit, { id: '2', name: 'V', role: 'V', expiresAt: '' });
  assert.deepEqual(v.files.map((f) => f.path).sort(), ['Countdown/countdown.html', 'vMix/V.vmix']);
  assert.equal(v.startup, 'vMix/V.vmix');
});

test('manifest carries the licence state', () => {
  const m = manifestFor(kit, { id: '1', name: 'H', role: 'H', expiresAt: '2026-10-25T03:59:00Z' }, Date.parse('2026-10-26T00:00:00Z'));
  assert.equal(m.licence.expired, true);
  assert.equal(m.licence.expiresAt, '2026-10-25T03:59:00Z');
});
