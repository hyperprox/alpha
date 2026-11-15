# The HyperProx demo

The demo runs the real frontend against a stand-in API that answers every page from invented data: a
three-node cluster called `homelab`, a remote "Family Server", and the plug-ins with rooms, devices,
streams and downloads. The live demo at **[demo.hyperprox.dev](https://demo.hyperprox.dev)** is this
same demo, in public mode.

- It opens straight onto the dashboard. There is no account and no sign-in.
- Every action shows its real dialogs: the master-password prompt (any password works), previews and
  plans. Then the API refuses the change with "In the demo nothing changes. Install HyperProx to do this
  for real". The refusal happens in the API, not by hiding buttons.
- Nothing can be revealed, sent or opened: no secrets, no Send files, no terminals, no websockets.
- A banner on every page says it is a demo, and a short guided tour runs on the first visit.

The demo is a separate entrypoint (`apps/api/src/demo`). It never loads a `.env` file, a database, the
vault or a credential store. It refuses to start if the environment holds a real install's settings, if
it would take the real ports (3000, 3002), or if its data directory holds anything that is not the
demo's. It makes no outbound connections: a guard in the process refuses every TCP, TLS, HTTP, UDP or
DNS request to anything but loopback (`apps/api/src/demo/no-outbound.ts`). The frontend process gets the
same guard.

## Run it locally

```bash
git clone https://github.com/hyperprox/alpha.git hyperprox && cd hyperprox
pnpm install
bash scripts/demo-fonts.sh   # optional: the typefaces, served by the demo itself
pnpm demo                    # first run builds both halves, then open http://127.0.0.1:3100
```

Both halves are production builds. The frontend builds into `apps/frontend/.next-demo`, never the real
`.next`. The API is compiled into `apps/api/dist-demo`. `HYPERPROX_DEMO_REBUILD=1 pnpm demo` rebuilds
both. `HYPERPROX_DEMO_HOST=0.0.0.0 pnpm demo` listens on every address, for example for a screenshot
machine. Without the fonts script, the demo uses the system fonts.

## Screenshots

To retake the screenshots:

1. Start the demo.
2. Copy `scripts/screenshots.mjs` into a folder where Playwright is installed
   (`npm i playwright && npx playwright install chromium`).
3. Run it there.

The script refuses any address that does not answer as the demo. By default it takes only the set kept
in `docs/screenshots`. `--all` takes every main page at desktop and phone size, dark and light, for
review.

```bash
node screenshots.mjs http://127.0.0.1:3100 /path/to/hyperprox/docs/screenshots
node screenshots.mjs --all http://127.0.0.1:3100 /tmp/hyperprox-shots
```

## Public mode (a live demo on the internet)

Public mode serves the whole demo on one address: the API answers there itself, and page requests go to
the demo frontend, which listens on loopback only. Public mode adds:

- **Rate limits.** Each visitor address gets 1,200 requests a minute, and 60 of them may be changes.
  The frontend's static files (scripts, styles, fonts) are not counted. The
  address comes from `X-Forwarded-For` only when the request arrives from a proxy named in
  `HYPERPROX_DEMO_TRUSTED_PROXIES`. The rate limiter remembers at most 10,000 addresses.
- **Generic errors.** A status and a plain sentence for it. No error text from the code reaches a visitor.
- **Secure cookies** (public mode is behind HTTPS).
- **Security headers on every answer.** A same-origin Content-Security-Policy (the pages load nothing
  from any other site), `nosniff`, no framing, no referrer, and a Permissions-Policy that turns off the
  camera, microphone, location and the like.
- **Size limits.** Request bodies are capped at 64 KiB (chunked ones too) and addresses at 2,048
  characters. Slow connections time out.
- **Read-only pages.** Only `GET` and `HEAD` reach the frontend, with only the headers a browser needs, and the
  path as parsed. A path with dot segments, encoded dots or slashes, or backslashes is refused. The public
  build (`HYPERPROX_DEMO_PUBLIC=1` at build time) has no `/api` rewrite, so the frontend never passes a path on
  to an API port of its own.
- **No per-visitor state on the server.** The password confirmation lives in the visitor's own cookie
  for five minutes. The only server-side memory is the capped rate-limit table, and a nightly restart
  clears it.
- **A stricter start-up guard.** Public mode will not start without an explicit listen address, or in a
  checkout that holds a real install's `.env`.

Run it on a machine of its own, never next to a real install. With a dedicated user `hpxdemo` and the
code in `/opt/hyperprox-demo/app`:

```bash
cd /opt/hyperprox-demo/app
pnpm install --frozen-lockfile
bash scripts/demo-fonts.sh
(cd apps/api && ./node_modules/.bin/tsc -p tsconfig.demo.json)
(cd apps/frontend && NODE_ENV=production NEXT_PUBLIC_HYPERPROX_DEMO=1 HYPERPROX_DEMO_PUBLIC=1 \
  HYPERPROX_NEXT_DIST=.next-demo HYPERPROX_API_PORT=3102 ./node_modules/.bin/next build)

cp deploy/demo/*.service deploy/demo/*.timer /etc/systemd/system/
cat > /etc/hyperprox-demo.env <<'EOF'
HYPERPROX_DEMO_LISTEN=10.0.0.50:8080
HYPERPROX_DEMO_TRUSTED_PROXIES=10.0.0.2
EOF
systemctl daemon-reload
systemctl enable --now hyperprox-demo-web hyperprox-demo hyperprox-demo-reset.timer
```

Install the app tree owned by root and readable by `hpxdemo` (only `.next-demo/cache` belongs to `hpxdemo`):
the services cannot change their own code.

```bash
chown -R root:root /opt/hyperprox-demo/app && chmod -R go-w /opt/hyperprox-demo/app
install -d -o hpxdemo -g hpxdemo /opt/hyperprox-demo/app/apps/frontend/.next-demo/cache
```

Replace the two addresses with this machine's address and your reverse proxy's. Then point the reverse
proxy (with HTTPS) at `http://<listen address>:8080`. `deploy/demo/` holds four units:

| Unit | What it does |
|---|---|
| `hyperprox-demo-web.service` | The frontend, on `127.0.0.1:3100`, with the outbound guard preloaded. |
| `hyperprox-demo.service` | The public address. |
| `hyperprox-demo-reset.timer` | Restarts both every night at 04:00. |
| `hyperprox-demo-reset.service` | The restart the timer runs. |

Both services run as `hpxdemo` with no capabilities, a system-call filter, no devices, a private `/tmp`, a
read-only view of the system and of their own code, and restart on failure. `MemoryDenyWriteExecute` is left
off on purpose: Node's JIT needs it.

The reverse proxy should:

- set `Strict-Transport-Security` (the demo does not, so there is one policy);
- send the visitor's address in `X-Forwarded-For` as the one address it saw, not one taken from a header the
  visitor sent. On Nginx Proxy Manager, whose real-IP settings trust `X-Real-IP` from CDN ranges, put
  `proxy_set_header X-Forwarded-For $realip_remote_addr;` in the host's advanced configuration. The demo keys its
  rate limit on the last `X-Forwarded-For` entry, and only when the request comes from a trusted proxy.

### Firewall

`deploy/demo/nftables.conf` lets in only the reverse proxy, on the demo's port, and lets nothing out but
replies and loopback. Replace `REVERSE_PROXY_IP` and `DEMO_PORT`, then:

```bash
cp deploy/demo/nftables.conf /etc/nftables.conf
systemctl enable --now nftables
```

### Maintenance

With the firewall on, the machine cannot download anything. Open the output chain for the job, then close it
by reloading the file:

```bash
nft add rule inet demo output udp dport 53 accept
nft add rule inet demo output tcp dport '{ 53, 80, 443 }' accept
apt-get update && apt-get upgrade       # or the rebuild below
nft -f /etc/nftables.conf               # closed again
```

To rebuild from a new checkout, open the chain as above and then:

1. Stop both services.
2. Replace `/opt/hyperprox-demo/app`.
3. Run the build steps above as root.
4. Set the ownership as above.
5. Start the services again.
6. Reload the firewall.

| Setting | Meaning |
|---|---|
| `HYPERPROX_DEMO=1` | Required, in every mode. |
| `HYPERPROX_DEMO_PUBLIC=1` | Public mode. |
| `HYPERPROX_DEMO_LISTEN` | `<ip>:<port>`. The one public address (required in public mode). |
| `HYPERPROX_DEMO_WEB_PORT` | The frontend's loopback port (default 3100). |
| `HYPERPROX_DEMO_TRUSTED_PROXIES` | A comma-separated list of the reverse proxies' IP addresses. |
| `HYPERPROX_DEMO_DATA` | The demo's own data directory. It must be outside the repo, and empty or already the demo's. |
