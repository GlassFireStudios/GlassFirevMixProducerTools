import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAuth, ipInCidr, newKey, ingestPath } from '../src/ingest.js';
import { computeKbps, describeTracks } from '../src/mediamtx.js';

const ctx = {
  ingests: [
    { key: 'riverside-0123456789abcdef', enabled: true },
    { key: 'old-feed-fedcba9876543210', enabled: false },
  ],
  legacy: { user: 'push', pass: 'legacy-secret' },
  readCidrs: ['172.31.0.0/16'],
};

test('ipInCidr', () => {
  assert.equal(ipInCidr('172.31.73.35', '172.31.0.0/16'), true);
  assert.equal(ipInCidr('::ffff:172.31.1.1', '172.31.0.0/16'), true);
  assert.equal(ipInCidr('172.32.0.1', '172.31.0.0/16'), false);
  assert.equal(ipInCidr('23.116.115.105', '172.31.0.0/16'), false);
  assert.equal(ipInCidr('127.0.0.1', '127.0.0.0/8'), true);
  assert.equal(ipInCidr('not-an-ip', '172.31.0.0/16'), false);
  assert.equal(ipInCidr('1.2.3', '0.0.0.0/0'), false);
});

test('publish: valid enabled key is allowed', () => {
  const d = decideAuth({ action: 'publish', path: 'live/riverside-0123456789abcdef', ip: '1.2.3.4' }, ctx);
  assert.equal(d.allow, true);
  assert.equal(d.reason, 'ingest-key');
});

test('publish: disabled, unknown, partial or wrong-app keys are denied', () => {
  for (const path of [
    'live/old-feed-fedcba9876543210',
    'live/riverside-0000000000000000',
    'live/riverside',
    'live/',
    'other/riverside-0123456789abcdef',
    'riverside-0123456789abcdef',
  ]) {
    assert.equal(decideAuth({ action: 'publish', path, ip: '1.2.3.4' }, ctx).allow, false, path);
  }
});

test('publish: legacy credentials still work, wrong password does not', () => {
  assert.equal(decideAuth({ action: 'publish', path: 'live/riverside', user: 'push', password: 'legacy-secret' }, ctx).allow, true);
  assert.equal(decideAuth({ action: 'publish', path: 'live/riverside', user: 'push', password: 'nope' }, ctx).allow, false);
  assert.equal(decideAuth({ action: 'publish', path: 'x', user: 'push', password: 'legacy-secret' }, { ...ctx, legacy: null }).allow, false);
});

test('read: only VPC and loopback', () => {
  assert.equal(decideAuth({ action: 'read', path: 'live/x', ip: '172.31.73.35' }, ctx).allow, true);
  assert.equal(decideAuth({ action: 'read', path: 'live/x', ip: '127.0.0.1' }, ctx).allow, true);
  assert.equal(decideAuth({ action: 'read', path: 'live/x', ip: '23.116.115.105' }, ctx).allow, false);
  assert.equal(decideAuth({ action: 'playback', path: 'live/x', ip: '8.8.8.8' }, ctx).allow, false);
});

test('api/metrics only from loopback', () => {
  assert.equal(decideAuth({ action: 'api', ip: '127.0.0.1' }, ctx).allow, true);
  assert.equal(decideAuth({ action: 'api', ip: '172.31.73.35' }, ctx).allow, false);
  assert.equal(decideAuth({ action: 'metrics', ip: '8.8.8.8' }, ctx).allow, false);
});

test('newKey / ingestPath shape', () => {
  const k = newKey('Riverside – Episode 12!');
  assert.match(k, /^riverside-episode-12-[0-9a-f]{16}$/);
  assert.notEqual(newKey('a'), newKey('a'));
  assert.equal(ingestPath(k), `live/${k}`);
});

test('computeKbps', () => {
  assert.equal(computeKbps(null, null, 1000, 1000), 0);
  assert.equal(computeKbps(0, 0, 125000, 1000), 1000); // 125 kB in 1s = 1000 kbps
  assert.equal(computeKbps(0, 0, 125000, 1000, 2000), 2000 * 0.6 + 1000 * 0.4);
  assert.equal(computeKbps(500, 0, 100, 1000, 7), 7); // counter reset keeps previous
});

test('describeTracks', () => {
  const t = describeTracks([
    { codec: 'H264', codecProps: { width: 1280, height: 720 } },
    { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 44100, channelCount: 2 } },
  ]);
  assert.deepEqual(t, { video: 'H264 1280x720', audio: 'MPEG-4 Audio 44k 2ch' });
  assert.deepEqual(describeTracks([]), { video: null, audio: null });
});
