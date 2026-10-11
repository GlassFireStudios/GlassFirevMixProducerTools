import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanReport, verdict } from '../src/screenchecks.js';

const decode = (v1080, v4k) => ({ h264_1080p30: v1080, h264_1080p60: v1080, h264_2160p30: v4k, h264_2160p60: v4k, hevc_2160p30: v4k });

test('4K screen, 4K decode, fast network: can show 4K', () => {
  assert.equal(verdict({ screenW: 3840, screenH: 2160, downMbps: 80, decode: decode('smooth', 'smooth') }).level, '4k');
});

test('portrait 4K screen counts by its long side', () => {
  assert.equal(verdict({ screenW: 2160, screenH: 3840, downMbps: 80, decode: decode('smooth', 'yes') }).level, '4k');
});

test('1080p screen is 1080p even with a 4K-capable player', () => {
  const v = verdict({ screenW: 1920, screenH: 1080, downMbps: 80, decode: decode('smooth', 'smooth') });
  assert.equal(v.level, '1080p');
  assert.match(v.label, /not 4K/);
});

test('4K screen on a slow network drops to 1080p', () => {
  assert.match(verdict({ screenW: 3840, screenH: 2160, downMbps: 12, decode: decode('smooth', 'smooth') }).label, /network/);
});

test('no 1080p decode or a crawling network is weak', () => {
  assert.equal(verdict({ screenW: 1920, screenH: 1080, downMbps: 50, decode: decode('no', 'no') }).level, 'weak');
  assert.equal(verdict({ screenW: 1920, screenH: 1080, downMbps: 3, decode: decode('smooth', 'no') }).level, 'weak');
});

test('cleanReport keeps only known fields and clips junk', () => {
  const r = cleanReport({ id: 'AB<script>12', name: 'x'.repeat(200), screenW: '3840', screenH: 1e9, downMbps: 'fast', decode: { h264_1080p30: 'smooth', h264_2160p30: 'maybe', evil: 'yes' }, extra: 1 });
  assert.equal(r.id, 'ABscript12');
  assert.equal(r.name.length, 60);
  assert.equal(r.screenW, 3840);
  assert.equal(r.screenH, 20000);
  assert.equal(r.downMbps, null);
  assert.equal(r.decode.h264_2160p30, 'unknown');
  assert.equal(r.decode.evil, undefined);
  assert.equal(r.extra, undefined);
  assert.ok(r.verdict);
});

test('cleanReport rejects a missing id', () => {
  assert.throws(() => cleanReport({ name: 'x' }));
});
