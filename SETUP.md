# SETUP — GlassFire vMix Producer Tools

What's done, and exactly what you still need to do by hand. Work top to bottom.

Legend: **[DONE]** handled automatically · **[TODO]** needs you · **[OPTIONAL]**

---

## Summary of what was built automatically

- **[DONE]** Connection store + dynamic poller (`data/connections.json`, atomic
  writes, live re-sync, 750 ms polling, HTTP Basic auth, 2 s timeout).
- **[DONE]** Producer views (`/`, `/s/:id`, `/grid.html`) driven by the live
  store — switcher bar, number-key nav, smooth interpolation, reconnecting WS,
  color/threshold states.
- **[DONE]** Companion-style admin dashboard at `/admin` — add/edit/remove/
  enable/reorder/test connections, live status, copy producer links, tunnel
  control, settings. Password-gated via signed session cookie.
- **[DONE]** Cloudflare tunnel manager with **named** (production) and **quick**
  (testing) modes, auto-retry with backoff, clean shutdown, dashboard status.
- **[DONE]** One-time provisioning script `scripts/provision-tunnel.mjs`.
- **[DONE]** `config.json` is migrated into the store on first run.

The mock environment is verified: `npm run mock` + `npm start` serves working
producer views from the store, and adding/disabling a connection in `/admin`
reflects in the producer views within ~1 s with no restart.

---

## 1. Cloudflare named tunnel → https://liveproducers.glassfire.co

**Status: [TODO] — not auto-provisioned.** `CLOUDFLARE_API_TOKEN` was not set in
the build environment, so the tunnel + DNS were **not** created automatically.

You have two options. **Option A is the least clicking.**

### Option A — let the script do it (recommended)

1. Create a Cloudflare API token (My Profile → API Tokens → Create Token →
   Custom) with these scopes:
   - **Account › Cloudflare Tunnel › Edit**
   - **Zone › DNS › Edit** (on `glassfire.co`)
   - **Zone › Zone › Read** (on `glassfire.co`)
2. Run, on the hub machine:
   ```bash
   export CLOUDFLARE_API_TOKEN=xxxxxxxx   # the token from step 1
   # export CF_ACCOUNT_ID=...             # optional; otherwise auto-resolved
   npm run provision-tunnel
   ```
   This creates (or reuses) a remotely-managed tunnel named
   **`glassfire-liveproducers`**, sets its ingress to
   `liveproducers.glassfire.co → http://localhost:8090`, creates the proxied
   `CNAME liveproducers → <id>.cfargotunnel.com` in the `glassfire.co` zone, and
   writes the tunnel token into `data/settings.json` (named mode). The token is
   never printed or committed.
3. Start the hub (`npm start`); the named tunnel connects automatically.

### Option B — set it up by hand in the dashboard

1. Go to <https://one.dash.cloudflare.com> → **Zero Trust → Networks →
   Connectors → Cloudflare Tunnels → Create a tunnel → Cloudflared**.
2. Name it `glassfire-liveproducers`. **Copy the tunnel token** it shows.
3. Add a **Public Hostname**:
   - Subdomain: `liveproducers`
   - Domain: `glassfire.co`
   - Type: **HTTP**
   - URL: `localhost:8090`
4. In the hub's `/admin` → **Settings**, set **Tunnel mode = Named**, paste the
   **Named tunnel token**, and **Save**. Then **Start** the tunnel in the Tunnel
   panel.

> **[TODO] Outbound network:** the hub needs outbound reach to Cloudflare on
> **TCP 7844** for the named tunnel (quick mode also needs
> `api.trycloudflare.com` + the Cloudflare edge). If you're behind a strict
> egress firewall, allow these.

---

## 2. Admin password

**Status: [DONE on first run].** If you do **not** set `ADMIN_PASSWORD`, the hub
generates a strong random password on first start, prints it to the console, and
writes it once to **`data/admin-password.txt`** (gitignored). Only its hash is
stored in `data/settings.json`.

- **[TODO]** On first `npm start`, copy the password from the console (or
  `data/admin-password.txt`) into your password manager, then **delete
  `data/admin-password.txt`**.
- **[OPTIONAL]** To set your own instead, run with `ADMIN_PASSWORD=...` in the
  environment (or `.env`), or change it later via the API. Changing
  `ADMIN_PASSWORD` re-hashes on next start.

> The dev/build environment generated a throwaway password in its own (ephemeral,
> gitignored) `data/` that does **not** ship with the repo. Your production
> machine generates its own on first run.

---

## 3. Producer access token (optional)

**Status: [OPTIONAL].** In `/admin → Settings`, set a **Producer access token**.
When set, producer links require `?k=TOKEN`, e.g.
`https://liveproducers.glassfire.co/s/<id>?k=TOKEN`. Leave blank to disable. The
dashboard's copy buttons include the token automatically once it's set.

---

## 4. AWS networking — how the hub reaches the vMixes

The hub can run on any always-on Linux box in your AWS account (Node 18+). It's
lightweight — polling a handful of vMix APIs every 750 ms and serving a small
web app + WebSockets — so it's fine to **co-locate it on an existing instance**
(e.g. a c5.large already doing NDI / shared storage). Just make sure:

- Node 18+ is installed, and nothing else on the box is already using port
  **8090** (if it is, run the hub with `PORT=<other>` and use that port wherever
  this guide says 8090 — including the tunnel ingress).
- The box has outbound internet to Cloudflare on **TCP 7844** (for the tunnel)
  and to the vMixes on their API port.
- `data/` lives on persistent storage (a mounted volume is ideal).

Then lock down how the hub reaches each vMix. Pick the case that matches you:

### Case A — hub and vMixes in the same VPC/region (recommended)

Being on AWS does **not** automatically put the hub "inside" a vMix's security
group — each instance has its own inbound rules. But in the same VPC you can do
better than an IP allow-list:

- Use each vMix's **private IP** as the *host* when you add the connection in
  `/admin`.
- On each vMix's security group, add inbound **TCP 8088** with
  **Source = the hub instance's security group** (`sg-…`). This
  "security-group referencing" means only the hub can reach the vMix, it keeps
  working even if the hub's IP changes, and the vMix API is never exposed to the
  public internet.

### Case B — different VPC/account, or using public IPs

- Attach an **Elastic IP** to the hub so its outbound IP is stable (a plain
  instance gets a new public IP on every stop/start, which would silently break
  the rule).
- On each vMix's security group, add inbound **TCP 8088 from
  `<hub-Elastic-IP>/32`** — never `0.0.0.0/0`.
- Use each vMix's **public IP** as the host in `/admin`.
- Find the hub's current egress IP from the hub: `curl -s https://api.ipify.org`.

### Either case — secure the vMix itself

- **[TODO] Enable the vMix Web Controller login** on every vMix
  (Settings → Web Controller → require a username/password). A reachable vMix Web
  API can *control* vMix, so this is not optional.
- **[TODO]** Enter those **username / password** when you add the connection in
  `/admin` so the hub authenticates.

---

## 5. Add the real vMix connections

**Status: [TODO] — you do this in the UI.** In `/admin → + Add connection`, for
each vMix:

- **Label** (e.g. “Main Stage”), **Color**.
- **Host** = the vMix's **private IP** (Case A) or **public IP** (Case B), and
  **Port** (default `8088`).
- **vMix username / password** (from step 4).
- **Input**: `active`, an input **number**, or an input **title**.
- **Warn at** / **Danger at** seconds (countdown thresholds).
- Click **Test connection** to confirm reachable / auth-ok / input-found before
  saving.

The two seeded `Stream A` / `Stream B` entries point at the local mocks — edit or
remove them once your real vMixes are in.

---

## 6. Run it persistently

- **[TODO]** Run the hub under a process manager so it survives reboots, e.g.
  systemd or `pm2 start npm --name vmix-hub -- start`.
- **[TODO]** Keep `data/` on persistent storage — it holds your connections and
  settings (and the tunnel token).
- **[TODO]** Start the named tunnel (auto-starts when a token is present, or via
  the `/admin` Tunnel panel).

---

## Quick reference

```bash
npm install                 # install deps (express, ws, fast-xml-parser, cloudflared)
npm run mock                # two fake vMixes on :18810 / :18811 (dev only)
npm start                   # the hub on http://localhost:8090  (admin at /admin)
npm run provision-tunnel    # one-time named-tunnel + DNS setup (needs CLOUDFLARE_API_TOKEN)
```

Producer URLs once the tunnel is up:

- Overview: `https://liveproducers.glassfire.co/`
- Per stream: `https://liveproducers.glassfire.co/s/<id>` (append `?k=TOKEN` if a
  producer token is set)
- Grid: `https://liveproducers.glassfire.co/grid.html`

---

## Outstanding TODOs (checklist)

- [ ] Provision the named tunnel (Option A or B) and confirm
      `https://liveproducers.glassfire.co/` returns the overview.
- [ ] Save the generated admin password and delete `data/admin-password.txt`.
- [ ] (Optional) Set a producer access token.
- [ ] Enable vMix Web Controller login on each AWS vMix.
- [ ] Lock each vMix security group — same-VPC: source = hub's security group
      (use private IPs); otherwise: hub's Elastic IP /32 (use public IPs). Allow
      hub egress to Cloudflare on 7844.
- [ ] Add the real vMix connections in `/admin` and remove the seeded mocks.
- [ ] Run the hub under a process manager and start the tunnel.
