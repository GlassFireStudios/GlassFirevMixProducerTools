import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePacketLine, parseAudioLine, summarizeVideo } from '../src/analyzer.js';
import { describeReader } from '../src/mediamtx.js';

test('parsePacketLine', () => {
  assert.deepEqual(parsePacketLine('0.067000,0.000000,0.033000,4929,K__'), { dts: 0, size: 4929, key: true, dur: 0.033 });
  assert.equal(parsePacketLine('0.1,0.067,0.033,996,___').key, false);
  assert.equal(parsePacketLine('0.1,N/A,0.033,996,___').dts, 0.1); // falls back to pts
  assert.equal(parsePacketLine('garbage'), null);
});

test('parseAudioLine: astats levels', () => {
  assert.deepEqual(parseAudioLine('[Parsed_ametadata_3 @ 0x1] lavfi.astats.1.Peak_level=-18.063656'),
    { kind: 'level', ch: 1, stat: 'peak', db: -18.063656 });
  assert.deepEqual(parseAudioLine('[Parsed_ametadata_3] lavfi.astats.2.RMS_level=-inf'),
    { kind: 'level', ch: 2, stat: 'rms', db: -Infinity });
});

test('parseAudioLine: ebur128 framelog', () => {
  const r = parseAudioLine('[Parsed_ebur128_4] t: 1.299977   TARGET:-23 LUFS    M: -26.8 S:-120.7     I: -21.5 LUFS       LRA:   0.0 LU');
  assert.deepEqual(r, { kind: 'loudness', m: -26.8, s: -120.7, i: -21.5, lra: 0 });
  assert.equal(parseAudioLine('[Parsed_ebur128_4] EBU +9 scale'), null);
});

test('summarizeVideo: steady 30fps', () => {
  const pk = Array.from({ length: 30 }, (_, i) => ({ dts: i / 30, size: 1000, key: i === 0 }));
  const s = summarizeVideo(pk, 1000 / 30);
  assert.equal(s.frames, 30);
  assert.equal(s.bytes, 30000);
  assert.equal(s.keys, 1);
  assert.equal(s.late, 0);
  assert.equal(Math.round(s.maxIntMs), 33);
});

test('summarizeVideo: a 200ms hole counts the missing frames', () => {
  const pk = [0, 1, 2, 8, 9].map((n) => ({ dts: n / 30, size: 1, key: false }));
  const s = summarizeVideo(pk, 1000 / 30);
  assert.equal(s.late, 5); // gap of 6 intervals = 5 frames missing
  assert.equal(Math.round(s.maxIntMs), 200);
});

test('summarizeVideo: backwards timestamps are counted, not treated as gaps', () => {
  const s = summarizeVideo([{ dts: 1, size: 1 }, { dts: 0.5, size: 1 }], 33);
  assert.equal(s.backwards, 1);
  assert.equal(s.late, 0);
});

test('describeReader marks loopback readers as the analyzer', () => {
  assert.equal(describeReader({ protocol: 'RTSP', remoteAddr: '127.0.0.1:5000' }).analyzer, true);
  assert.equal(describeReader({ protocol: 'RTMP', remoteAddr: '127.0.0.1:5001' }).analyzer, true);
  assert.equal(describeReader({ protocol: 'SRT', remoteAddr: '172.31.73.35:52684', msRTT: 0.4 }).analyzer, false);
  assert.equal(describeReader({ protocol: 'SRT', remoteAddr: '172.31.73.35:1', msRTT: 0.4 }).rttMs, 0.4);
});
