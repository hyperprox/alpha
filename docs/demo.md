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
- **Security headers on every answer.** A same-origin Content-Security-Policy (the pages load nothing
  from any other site), `nosniff`, no framing, no referrer, and a Permissions-Policy that turns off the
  camera, microphone, location and the like.
- **Size limits.** Request bodies are capped at 64 KiB (chunked ones too) and addresses at 2,048
  characters. Slow connections time out.
- **Read-only pages.** Only `GET` and `HEAD` reach the frontend, with only the headers a browser needs.
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
(cd apps/frontend && NODE_ENV=production NEXT_PUBLIC_HYPERPROX_DEMO=1 HYPERPROX_NEXT_DIST=.next-demo \
  HYPERPROX_API_PORT=3102 ./node_modules/.bin/next build)

cp deploy/demo/*.service deploy/demo/*.timer /etc/systemd/system/
cat > /etc/hyperprox-demo.env <<'EOF'
HYPERPROX_DEMO_LISTEN=10.0.0.50:8080
HYPERPROX_DEMO_TRUSTED_PROXIES=10.0.0.2
EOF
systemctl daemon-reload
systemctl enable --now hyperprox-demo-web hyperprox-demo hyperprox-demo-reset.timer
```

Replace the two addresses with this machine's address and your reverse proxy's. Then point the reverse
proxy (with HTTPS) at `http://<listen address>:8080`. `deploy/demo/` holds four units:

| Unit | What it does |
|---|---|
| `hyperprox-demo-web.service` | The frontend, on `127.0.0.1:3100`, with the outbound guard preloaded. |
| `hyperprox-demo.service` | The public address. |
| `hyperprox-demo-reset.timer` | Restarts both every night at 04:00. |
| `hyperprox-demo-reset.service` | The restart the timer runs. |

Both services run as `hpxdemo`, restart on failure, and run under systemd's file system protections.

| Setting | Meaning |
|---|---|
| `HYPERPROX_DEMO=1` | Required, in every mode. |
| `HYPERPROX_DEMO_PUBLIC=1` | Public mode. |
| `HYPERPROX_DEMO_LISTEN` | `<ip>:<port>`. The one public address (required in public mode). |
| `HYPERPROX_DEMO_WEB_PORT` | The frontend's loopback port (default 3100). |
| `HYPERPROX_DEMO_TRUSTED_PROXIES` | A comma-separated list of the reverse proxies' IP addresses. |
| `HYPERPROX_DEMO_DATA` | The demo's own data directory. It must be outside the repo, and empty or already the demo's. |
