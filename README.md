# GlassFire vMix Producer Tools

A small Node hub that **connects out to your vMix machines over the public
internet**, reads each one's Web API, and serves remote producers a live,
glanceable **playlist countdown** for every stream — plus a Companion-style
**admin dashboard** to manage the connections and a **named Cloudflare tunnel**
that publishes the producer views at a fixed URL.

- **No agent on the vMix machines.** The vMixes are AWS instances with public
  IPs. The hub polls each one's `http://<public-ip>:8088/api` directly, exactly
  like a Companion connection. You point the hub *at* them.
- **Producer views** show a big countdown per stream, color/threshold states
  (ok / warn / danger), the current playlist item, a switcher bar, number-key
  navigation, smooth interpolation between updates, and a reconnecting WebSocket.
- **Admin dashboard** (`/admin`) adds/edits/removes/enables/reorders connections,
  tests them, shows live status, and controls the tunnel — no file editing, no
  restarts.
- **Named tunnel** fronts the producer views at
  **https://liveproducers.glassfire.co**.

Plain Node + ESM, Node 18+. No build step, no front-end framework. Dependencies:
`express`, `ws`, `fast-xml-parser`, `cloudflared`.

---

## Quick start (with mock vMixes)

```bash
npm install
npm run mock      # terminal 1: two fake vMixes on :18810 and :18811
npm start         # terminal 2: the hub on http://localhost:8090
```

Then open:

- Producer overview: <http://localhost:8090/>
- A single stream: <http://localhost:8090/s/stream-a>
- Grid: <http://localhost:8090/grid.html>
- Admin: <http://localhost:8090/admin>

On first run the hub migrates `config.json` into the connection store
(`data/connections.json`) and, if no `ADMIN_PASSWORD` is set, generates an admin
password (printed to the console and written once to `data/admin-password.txt`).

---

## How it works

```
 producers' browsers
        │  https://liveproducers.glassfire.co     (named Cloudflare tunnel)
        ▼
 ┌──────────────┐     polls every 750ms, HTTP Basic auth
 │   the hub    │ ───────────────────────────────────────► vMix #1  http://PUBLIC_IP:8088/api
 │ (this repo)  │ ───────────────────────────────────────► vMix #2  http://PUBLIC_IP:8088/api
 └──────────────┘                                           (AWS instances, public IPs)
   express + ws
   /admin dashboard
   data/connections.json, data/settings.json
```

- **Connection store** — `data/connections.json`, atomic writes. One record per
  vMix: `{ id, label, color, host, port, username?, password?, input, warnSeconds,
  dangerSeconds, enabled, order }`. `id` is a stable url-safe slug of the label.
- **Dynamic poller** — polls each enabled connection's `/api` every 750 ms (2 s
  timeout), sends HTTP Basic auth when creds are set, parses via `src/vmix.js`,
  classifies against the thresholds, and broadcasts over WebSocket. Add / edit /
  remove / enable / reorder re-syncs the poller live — no restart.
- **Producer views** read from the live store (`/api/streams`, `/api/state/:id`,
  and the `/ws` socket), not from a static file.

## Admin dashboard

Open `/admin` and sign in with the admin password. You can:

- **Add / edit / remove / enable / reorder** connections entirely from the UI.
- **Test** a connection before saving — reports reachable / auth-ok / input-found
  / sample remaining, without writing anything.
- See **live status** per connection (reachable, vMix state, remaining, current
  item).
- Copy the **producer link** for each connection.
- Set a **producer access token** and the **tunnel mode**, and **start/stop** the
  tunnel.

## Tunnel modes

Persisted in `data/settings.json`:

- **Named (production, default)** — runs the bundled `cloudflared` with your
  tunnel token and publishes at the fixed hostname
  `https://liveproducers.glassfire.co`. Auto-retries with backoff on crash, stops
  cleanly on shutdown, and reports status in the dashboard.
- **Quick (testing)** — used when no token is set; prints a random
  `*.trycloudflare.com` URL.

Provision the named tunnel once with `npm run provision-tunnel` (needs
`CLOUDFLARE_API_TOKEN`), or set it up by hand in the Cloudflare dashboard and
paste the token in `/admin`. See [SETUP.md](./SETUP.md).

## Security — please read

A vMix Web API reachable on a public IP **can control vMix**, not just report on
it. Treat each vMix's public endpoint as sensitive:

1. **Enable the vMix Web Controller login** (Basic auth) on every AWS vMix, and
   enter those credentials when you add the connection here.
2. **Lock each vMix's AWS security group** so port 8088 is reachable **only from
   this hub's egress IP** — not the whole internet.
3. Optionally set a **producer access token** in `/admin` so a leaked producer
   URL alone isn't enough (links then need `?k=TOKEN`).
4. The admin dashboard and all admin/connection/tunnel/settings APIs are gated by
   an admin password (signed session cookie).

Secrets (Cloudflare tokens, admin password, vMix credentials) live only in
`data/` or environment variables — never in the repo, never logged. `data/` and
`.env` are gitignored.

## Files

| Path | Purpose |
|------|---------|
| `src/server.js` | Express + WebSocket hub; producer + admin routes |
| `src/vmix.js` | vMix `/api` fetch (Basic auth) + XML parse to `{ state, remainingMs, list }` |
| `src/store.js` | Connection store, atomic writes, legacy migration |
| `src/settings.js` | Settings + admin password hashing + tunnel config |
| `src/auth.js` | Signed-cookie admin sessions |
| `src/poller.js` | Dynamic 750 ms poller, live re-sync |
| `src/tunnel.js` | Cloudflare tunnel manager (named/quick) |
| `scripts/mock-vmix.js` | Two fake vMixes for local dev (`npm run mock`) |
| `scripts/provision-tunnel.mjs` | One-time named-tunnel provisioning via Cloudflare API |
| `public/*` | Producer views + admin dashboard (control-room theme) |

## Running in production

- Put the hub behind a process manager (systemd, pm2) so it restarts on reboot.
- Ensure outbound reach to Cloudflare on **TCP 7844** for the named tunnel.
- Keep `data/` on persistent storage (it holds your connections and settings).
