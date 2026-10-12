// Two fake vMix Web APIs for local development, on :18810 and :18811.
//
// Each serves /api with vMix-style XML whose active List input counts down and
// cycles through playlist items, so the producer views show a live countdown
// without any real vMix. Run with `npm run mock`.

import http from 'http';

function buildSnapshot({ title, items, cycleMs }) {
  const now = Date.now();
  const total = items.length;
  const itemMs = cycleMs;
  const elapsedInCycle = now % itemMs;
  const selectedIndex = Math.floor(now / itemMs) % total;
  const position = elapsedInCycle;
  const duration = itemMs;
  const state = 'Running';

  const itemXml = items
    .map((name, i) => `      <item selected="${i === selectedIndex ? 'true' : 'false'}">${name}</item>`)
    .join('\n');

  return `<vmix>
  <version>27.0.0.49</version>
  <edition>4K</edition>
  <active>1</active>
  <preview>2</preview>
  <inputs>
    <input key="11111111-1111-1111-1111-111111111111" number="1" type="VideoList" title="${title}" state="${state}" position="${position}" duration="${duration}" loop="False">
      <list>
${itemXml}
      </list>
    </input>
    <input key="22222222-2222-2222-2222-222222222222" number="2" type="Colour" title="Backup" state="Paused" position="0" duration="0" />
  </inputs>
  <overlays></overlays>
  <transitions></transitions>
</vmix>`;
}

function startMock(port, opts) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === '/api') {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(buildSnapshot(opts));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('mock vMix: only /api is implemented');
  });
  srv.listen(port, () => console.log(`[mock-vmix] "${opts.title}" on http://localhost:${port}/api`));
  return srv;
}

startMock(18810, {
  title: 'Main Stage Playlist',
  items: ['Opening Bumper.mp4', 'Keynote Roll-in.mp4', 'Sponsor Spot.mp4', 'Closing Card.mp4'],
  cycleMs: 45000,
});
startMock(18811, {
  title: 'Breakout Room Playlist',
  items: ['Welcome Loop.mp4', 'Session Title.mp4', 'Q&A Slate.mp4'],
  cycleMs: 25000,
});

console.log('[mock-vmix] running. Stop with Ctrl+C.');
