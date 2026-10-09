import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromStatuspage, fromRss, fromAws, worst } from '../src/servicestatus.js';
import { parseVmixState, vmixCallUrl, newInviteCode } from '../src/vmixcalls.js';

test('worst()', () => {
  assert.equal(worst(['ok', 'minor', 'ok']), 'minor');
  assert.equal(worst(['ok', 'unknown']), 'unknown');
  assert.equal(worst(['minor', 'down', 'major']), 'down');
  assert.equal(worst([]), 'ok');
});

test('fromStatuspage: indicator + broken components + open incidents', () => {
  const r = fromStatuspage({
    status: { indicator: 'minor', description: 'Partially Degraded Service' },
    components: [{ name: 'Meetings', status: 'degraded_performance' }, { name: 'Chat', status: 'operational' }],
    incidents: [{ name: 'Join delays', status: 'investigating', impact: 'minor' }, { name: 'Old', status: 'resolved' }],
  });
  assert.equal(r.state, 'minor');
  assert.deepEqual(r.broken, ['Meetings: degraded performance']);
  assert.equal(r.incidents.length, 1);
});

test('fromStatuspage with focus ignores unrelated components', () => {
  const j = { status: { indicator: 'major' }, components: [
    { name: 'Arica, Chile - (ARI)', status: 'major_outage' },
    { name: 'Cloudflare Tunnel', status: 'operational' },
  ], incidents: [] };
  assert.equal(fromStatuspage(j, /tunnel|ashburn/i).state, 'ok');
  j.components[1].status = 'partial_outage';
  assert.equal(fromStatuspage(j, /tunnel|ashburn/i).state, 'major');
});

test('fromRss flags recent unresolved items only', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const xml = `<rss><channel>
    <item><title>InControl degraded</title><pubDate>Thu, 08 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>Old thing resolved</title><pubDate>Mon, 01 Jan 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  assert.equal(fromRss(xml, now).state, 'minor');
  assert.equal(fromRss(xml.replace('InControl degraded', 'InControl degraded - Resolved'), now).state, 'ok');
});

test('fromAws only counts us-east-1 / global', () => {
  assert.equal(fromAws([{ region_name: 'eu-west-1', summary: 'x' }]).state, 'ok');
  assert.equal(fromAws([{ region_name: 'N. Virginia', summary: 'EC2 issue' }]).state, 'minor');
});

test('parseVmixState reads call inputs and keeps passwords as strings', () => {
  const xml = `<vmix><version>29.0.0.49</version><edition>Pro</edition><preset>C:\\x\\Show.vmix</preset><inputs>
    <input key="a1" number="1" type="SRT" title="SRT 1">SRT 1</input>
    <input key="b2" number="2" type="VideoCall" title="Call - Guest" callPassword="012345" callConnected="True" callVideoSource="Output1" callAudioSource="Master" muted="False" meterF1="0.5" meterF2="0">Call</input>
  </inputs><recording duration="10">True</recording><streaming>False</streaming><external>False</external>
  <audio><master meterF1="0.1" meterF2="0.1"/></audio></vmix>`;
  const s = parseVmixState(xml);
  assert.equal(s.version, '29.0.0.49');
  assert.equal(s.preset, 'Show.vmix');
  assert.equal(s.recording, true);
  assert.equal(s.streaming, false);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].password, '012345');
  assert.equal(s.calls[0].connected, true);
  assert.equal(s.calls[0].db[0], -6);
  assert.equal(s.calls[0].db[1], null);
});

test('vmixCallUrl + invite codes', () => {
  assert.equal(vmixCallUrl('012345', 'Jo Smith'), 'https://www.vmixcall.com/call.aspx?Key=012345&Name=Jo+Smith');
  const c = newInviteCode();
  assert.match(c, /^[a-z2-9]{10}$/);
  assert.notEqual(c, newInviteCode());
});

import { summarizeDevice } from '../src/peplink.js';

test('summarizeDevice tolerates IC2 field variants', () => {
  const d = summarizeDevice({
    id: 7, group_id: 3, name: 'GFBR2MAX Bravo', sn: 'ABCD', product_name: 'MAX BR2', fw_ver: '8.5.2', onlineStatus: 'ONLINE',
    interfaces: [
      { id: 1, name: 'Cellular 1', type: 'gobi', status: 'Connected', ip: '10.0.0.2', carrier_name: 'Verizon', gobi_band_class_name: 'LTE B13', cellular_signals: { rsrp: -95, rsrq: -11, sinr: 9, rssi: -70 } },
      { id: 9, name: 'LAN', type: 'lan' },
    ],
  });
  assert.equal(d.online, true);
  assert.equal(d.model, 'MAX BR2');
  assert.equal(d.wans.length, 1);
  assert.equal(d.wans[0].carrier, 'Verizon');
  assert.equal(d.wans[0].rsrp, -95);
  assert.equal(summarizeDevice({ name: 'x', status: 'offline' }).online, false);
});

import { summarizeData } from '../src/peplink.js';

test('summarizeData: eSIM plan, per-SIM remaining, month usage', () => {
  const r = summarizeData({
    sfconnect_data_plan: { name: 'NA & EU eSIM', expiry_date: '2028-10-03T23:59:59', usage_quota_kb: 79046354, usage_consumed_kb: 21574006, quota_left_kb: 57472348 },
    interfaces: [{ id: 3, speedfusion_connect_5gLte: { remainingQuotaKb: 38859785 } }, { id: 4, speedfusion_connect_5gLte: { remainingQuotaKb: 0 } }, { id: 1 }],
  }, { usages: [{ from_date: '2026-10-01T00:00:00', to_date: '2999-10-31T23:59:59', up: 48783.1, down: 47044.9 }] });
  assert.equal(r.plan.leftKb, 57472348);
  assert.equal(r.wanQuota[3].leftKb, 38859785);
  assert.equal(r.wanQuota[4].leftKb, 0);
  assert.equal(r.wanQuota[1], undefined);
  assert.equal(r.monthUsage.downMb, 47044.9);
  assert.equal(summarizeData({}, null).plan, null);
});

import { summarizeUsage } from '../src/starlink.js';

test('summarizeUsage: remaining = plan limit - used this cycle', () => {
  const u = summarizeUsage({
    serviceLineNumber: 'SL-1', lastUpdated: '2026-10-08T00:00:00Z',
    billingCycles: [
      { startDate: '2026-09-01', endDate: '2026-09-30', totalPriorityGB: 90, totalStandardGB: 0 },
      { startDate: '2026-10-01', endDate: '2026-10-31', totalPriorityGB: 12.34, totalStandardGB: 3.2, dailyDataUsage: [{ date: '2026-10-01', priorityGB: 1, standardGB: 0 }] },
    ],
    servicePlan: { productId: 'p1', usageLimitGB: 50, isOptedIntoOverage: true, overageLine: { consumedAmountGB: 12.34, overageAmountGB: 0 } },
  }, { p1: 'Local Priority 50GB' });
  assert.equal(u.plan, 'Local Priority 50GB');
  assert.equal(u.cycleStart, '2026-10-01');
  assert.equal(u.usedGB, 12.3);
  assert.equal(u.leftGB, 37.7);
  assert.equal(u.standardGB, 3.2);
  assert.equal(u.daily.length, 1);
  assert.equal(summarizeUsage({}).leftGB, null);
});
