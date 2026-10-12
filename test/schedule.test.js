import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSeconds, effective, parseShift, cleanItem, scheduleFiles, describeShift } from '../src/schedule.js';

test('wall-clock arithmetic crosses minutes, hours and midnight', () => {
  assert.equal(addSeconds('2026-10-22T14:00', 30), '2026-10-22T14:00:30');
  assert.equal(addSeconds('2026-10-22T14:00', -90), '2026-10-22T13:58:30');
  assert.equal(addSeconds('2026-10-22T23:59', 120), '2026-10-23T00:01:00');
  assert.equal(effective({ start: '2026-10-22T14:00', shiftSec: 180 }), '2026-10-22T14:03:00');
});

test('manual shift entry', () => {
  assert.equal(parseShift('3'), 180);
  assert.equal(parseShift('2:30'), 150);
  assert.equal(parseShift('30s'), 30);
  assert.equal(parseShift('-1'), -60);
  assert.equal(parseShift('-0:45'), -45);
  assert.equal(parseShift('+5 min'), 300);
  assert.equal(parseShift('1.5'), 90);
  assert.equal(parseShift('soon'), null);
});

test('items are validated', () => {
  assert.throws(() => cleanItem({ kind: 'event', title: 'x', start: '22 Oct 2pm' }));
  assert.throws(() => cleanItem({ kind: 'block', start: '2026-10-22T14:00' }));
  assert.throws(() => cleanItem({ kind: 'event', title: 'x', start: '2026-10-22T14:00', shiftSec: 999999 }));
  assert.equal(cleanItem({ kind: 'event', title: 'x', start: '2026-10-22T14:00', look: 'neon' }).look, 'equip');
});

test('files carry actual times, sorted, without disabled items', () => {
  const s = { version: 3, updatedAt: 0, items: [
    { id: 'a', kind: 'block', name: '4 THU B', start: '2026-10-22T09:30', shiftSec: 0 },
    { id: 'b', kind: 'block', name: '5 THU C', start: '2026-10-22T12:30', shiftSec: -600 },
    { id: 'c', kind: 'event', title: 'ENERGIZE', where: 'B103', start: '2026-10-22T14:00', shiftSec: 150, look: 'energize' },
    { id: 'd', kind: 'event', title: 'Hidden', start: '2026-10-22T13:00', enabled: false },
  ] };
  const [js, txt] = scheduleFiles(s);
  assert.equal(js.path, 'Countdown/schedule.js');
  assert.match(js.content, /window\.EQUIP_SCHEDULE = /);
  const data = JSON.parse(js.content.split('= ')[1].replace(/;\s*$/, ''));
  assert.deepEqual(data.events.map((e) => [e.title, e.start]), [['ENERGIZE', '2026-10-22T14:02:30']]);
  assert.equal(txt.content, '2026-10-22T09:30:00|4 THU B\r\n2026-10-22T12:20:00|5 THU C\r\n');
  assert.match(js.sha256, /^[0-9a-f]{64}$/);
});

test('shift wording', () => {
  assert.equal(describeShift(150), '2 min 30 s later');
  assert.equal(describeShift(-30), '30 s earlier');
});
