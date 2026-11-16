// =============================================================================
//  HyperProx — the DNS blocker recipes: Pi-hole and AdGuard Home
//
//  Both are network-wide DNS ad and tracker blockers: devices ask them for a name, and they answer "no such
//  place" for the names on their block lists. Each is installed so that it is finished, not half set up: the
//  admin password is generated (never a vendor default) and kept in the vault, the lists are loaded, and DNS
//  listens on the container's own LAN address only, never on every interface.
//
//  Neither install touches any other machine's DNS. Pointing the network at the blocker is the owner's
//  decision (the router's DHCP DNS setting), and the Catalogue page says so in a box beside the result.
//
//  Pi-hole runs from its official image, pinned by tag and digest (the installer script on the project's site
//  cannot be pinned to a release). AdGuard Home runs from the release tarball of one version, checked against the
//  SHA-256 the project publishes for it, as a systemd service.
//
//  Upstream DNS: the person may list the resolvers the blocker forwards to. Blank means the resolvers this
//  container was given (the ones the cluster already uses), and 1.1.1.1 only when it was given none.
// =============================================================================

import type { CatalogueRecipe, RecipeOption } from '../catalogue'
import type { Fingerprint } from '../catalogue-detect'

export const PIHOLE_RECIPE_ID = 'pihole'
export const ADGUARD_RECIPE_ID = 'adguard-home'

/**
 * Pi-hole's Docker image: release 2026.10.1 (Pi-hole core 6.5, FTL 6.8, web 6.6.1), by tag and by the digest of its
 * multi-arch index, so the tag cannot be moved under an install. Changing it is an upgrade, made on purpose.
 */
export const PIHOLE_VERSION = '2026.10.1'
export const PIHOLE_IMAGE = `pihole/pihole:${PIHOLE_VERSION}@sha256:30f803ad5dd60ff96cc0a63008a2e9271af481c1b0399a182192b2e91152c1f9`
export const PIHOLE_DIR = '/opt/pihole'

/** AdGuard Home release v0.107.79, and the SHA-256 of its amd64 tarball from the release's own checksums.txt. */
export const ADGUARD_VERSION = 'v0.107.79'
export const ADGUARD_SHA256_AMD64 = 'c48f4a43000665484c5ec28177de11a004759b620dae8f77b2aabefc9ef3687f'
export const ADGUARD_DIR = '/opt/AdGuardHome'

// ── options ─────────────────────────────────────────────────────────────────

const UPSTREAM_ONE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f:]{2,39})(?:#\d{1,5})?$/

export const DNS_OPTIONS: RecipeOption[] = [
  { key: 'DNS_UPSTREAMS', label: 'Upstream DNS servers (optional)', kind: 'text', maxLength: 200, placeholder: '1.1.1.1, 9.9.9.9',
    hint: 'The resolvers it asks for names it does not block, as IP addresses separated by commas. Blank: the resolvers this container was given, which are the ones your cluster already uses.' },
]

/** Checks across the options, after each passed its own kind: every upstream is one IP address (and an optional #port). */
export function checkDnsOptions(v: Record<string, string>): string[] {
  const out: string[] = []
  const list = (v.DNS_UPSTREAMS ?? '').split(',').map(x => x.trim()).filter(Boolean)
  if (list.length > 4) out.push('Upstream DNS servers: at most four.')
  for (const u of list) if (!UPSTREAM_ONE.test(u)) out.push(`Upstream DNS servers: "${u}" is not an IP address (add #port for a port other than 53).`)
  return out
}

/** The upstream list the script works out, in one place so the Pi-hole and AdGuard scripts agree. */
const UPSTREAM_SH = String.raw`# The resolvers to forward to: the ones chosen, else the ones this container was given (never a loopback one).
UP="$DNS_UPSTREAMS"
if [ -z "$UP" ]; then
  UP=$(awk '/^nameserver/ && $2 !~ /^(127\.|::1$)/ { print $2 }' /etc/resolv.conf | paste -sd, -)
fi
[ -n "$UP" ] || UP=1.1.1.1
UP=$(printf '%s' "$UP" | tr -d ' ')`

/** The container's own LAN address: DNS and the web page are published here and nowhere else. */
const LAN_IP_SH = String.raw`LAN_IP=$(ip -4 -o addr show eth0 | awk '{ print $4 }' | cut -d/ -f1 | head -n1)
if [ -z "$LAN_IP" ]; then echo "This container has no IPv4 address on eth0, so the blocker cannot be bound to it." >&2; exit 1; fi`

// ── Pi-hole ─────────────────────────────────────────────────────────────────

/**
 * The compose file. DNS (both transports) and the web page are published on the container's LAN address only. The
 * password is a Compose secret the image reads itself (WEBPASSWORD_FILE), never an environment value.
 * @LAN_IP@ is filled in by the script, from the address it read itself. The upstreams are deliberately NOT an environment
 * setting: Pi-hole makes any setting given that way read-only through its API, and the plug-in must be able to switch them.
 */
export function piholeCompose(): string {
  return `name: pihole
services:
  pihole:
    image: ${PIHOLE_IMAGE}
    container_name: pihole
    restart: unless-stopped
    ports:
      - "@LAN_IP@:53:53/tcp"
      - "@LAN_IP@:53:53/udp"
      - "@LAN_IP@:80:80/tcp"
    environment:
      TZ: Etc/UTC
      # Behind Docker's bridge the container sees every query as coming from the bridge, so it must answer them all;
      # who can reach it is decided by the published ports above.
      FTLCONF_dns_listeningMode: ALL
      WEBPASSWORD_FILE: pihole_password
    secrets: [pihole_password]
    volumes:
      - ./etc-pihole:/etc/pihole
secrets:
  pihole_password:
    file: ./secrets/pihole_password
`
}

export const PIHOLE_SCRIPT = (String.raw`# The installer runs scripts under umask 077; the files written here are made readable on purpose below.
umask 022
# The generated password stays in this shell and reaches the container only as a Compose secret file.
PW="$PIHOLE_PASSWORD"
unset PIHOLE_PASSWORD
if [ -z "$PW" ]; then echo "The installer did not pass the generated password." >&2; exit 1; fi

apt-get update -qq
apt-get install -y -qq ca-certificates curl docker.io docker-compose
systemctl enable --now docker

` + LAN_IP_SH + String.raw`
` + UPSTREAM_SH + String.raw`
D=` + PIHOLE_DIR + String.raw`
mkdir -p $D/secrets $D/etc-pihole
chmod 700 $D/secrets
( umask 077; printf '%s' "$PW" > $D/secrets/pihole_password )

cat > $D/docker-compose.yml <<'HP_COMPOSE'
@COMPOSE@HP_COMPOSE
sed -i "s|@LAN_IP@|$LAN_IP|g" $D/docker-compose.yml

cd $D
# --quiet-pull keeps progress bars out of the output, so a failure's last lines are the error.
docker compose up -d --quiet-pull
for i in $(seq 1 60); do
  C=$(curl -s -o /dev/null --max-time 3 -w "%{http_code}" "http://$LAN_IP/api/info/login" || true)
  [ "$C" = 200 ] && break
  sleep 2
done
[ "$C" = 200 ] || { echo "Pi-hole did not answer on http://$LAN_IP after two minutes." >&2; docker logs --tail 30 pihole >&2 || true; exit 1; }

# The upstreams, through Pi-hole's own API (so they stay changeable from the plug-in). The password and the session id
# reach curl on standard input, never on a command line; the session is closed again at the end.
UPJSON=$(printf '%s' "$UP" | awk -F, '{ for (i = 1; i <= NF; i++) printf "%s\"%s\"", (i > 1 ? "," : ""), $i }')
SID=$(printf '{"password":"%s"}' "$PW" | curl -fsS --max-time 20 -X POST -H 'Content-Type: application/json' --data-binary @- "http://$LAN_IP/api/auth" | sed -n 's/.*"sid":"\([^"]*\)".*/\1/p')
unset PW
if [ -z "$SID" ]; then echo "Pi-hole did not accept the generated password." >&2; exit 1; fi
( umask 077; printf '{"config":{"dns":{"upstreams":[%s]}}}' "$UPJSON" > /tmp/pihole-upstreams.json )
curl -fsS --max-time 30 -K - <<CURLCFG >/dev/null
url = "http://$LAN_IP/api/config"
request = "PATCH"
header = "sid: $SID"
header = "Content-Type: application/json"
data-binary = "@/tmp/pihole-upstreams.json"
CURLCFG
rm -f /tmp/pihole-upstreams.json
curl -sS --max-time 10 -K - -X DELETE <<CURLCFG >/dev/null || true
url = "http://$LAN_IP/api/auth"
header = "sid: $SID"
CURLCFG
unset SID
echo "Pi-hole ` + PIHOLE_VERSION + String.raw` is serving DNS and its web page on $LAN_IP only, forwarding to $UP."`).replace('@COMPOSE@', () => piholeCompose())

// ── AdGuard Home ────────────────────────────────────────────────────────────

/**
 * The install follows AdGuard Home's own first-run API on the container's loopback (the way its setup page does it), so
 * AdGuard hashes the password itself: the script never writes a hash. The password reaches curl on standard input.
 */
export const ADGUARD_SCRIPT = String.raw`# The installer runs scripts under umask 077; the program must be readable by its service.
umask 022
PW="$ADGUARD_PASSWORD"
unset ADGUARD_PASSWORD
if [ -z "$PW" ]; then echo "The installer did not pass the generated password." >&2; exit 1; fi
case "$(uname -m)" in x86_64) ;; *) echo "This recipe installs the amd64 build only." >&2; exit 1 ;; esac

apt-get update -qq
apt-get install -y -qq ca-certificates curl

` + LAN_IP_SH + String.raw`
` + UPSTREAM_SH + String.raw`

D=` + ADGUARD_DIR + String.raw`
if [ -e $D/AdGuardHome.yaml ]; then echo "AdGuard Home is already installed in this container; its settings are kept." >&2; exit 1; fi
# The release tarball of one version, checked against the SHA-256 the project publishes for it before it is unpacked.
curl -fsSLo /tmp/adguard.tar.gz https://github.com/AdguardTeam/AdGuardHome/releases/download/` + ADGUARD_VERSION + String.raw`/AdGuardHome_linux_amd64.tar.gz
echo "` + ADGUARD_SHA256_AMD64 + String.raw`  /tmp/adguard.tar.gz" | sha256sum -c --quiet
tar -xzf /tmp/adguard.tar.gz -C /opt
rm -f /tmp/adguard.tar.gz
cd $D

# First run: AdGuard Home's setup API answers until it has an admin. It is started by hand for this, on the container's
# loopback only (never on the network, where anyone could claim it), and set up on the LAN address by its own setup call.
./AdGuardHome --no-check-update -w $D -c $D/AdGuardHome.yaml --web-addr 127.0.0.1:3000 >/tmp/adguard-first-run.log 2>&1 &
FIRST=$!
for i in $(seq 1 30); do
  C=$(curl -s -o /dev/null --max-time 3 -w "%{http_code}" http://127.0.0.1:3000/control/install/get_addresses || true)
  [ "$C" = 200 ] && break
  sleep 2
done
[ "$C" = 200 ] || { echo "AdGuard Home's setup did not start." >&2; tail -20 /tmp/adguard-first-run.log >&2; kill $FIRST 2>/dev/null || true; exit 1; }
printf '{"web":{"ip":"%s","port":80},"dns":{"ip":"%s","port":53},"username":"admin","password":"%s"}' "$LAN_IP" "$LAN_IP" "$PW" \
  | curl -fsS --max-time 60 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:3000/control/install/configure >/dev/null

# It now serves the LAN address. Wait for the signed-in API.
for i in $(seq 1 30); do
  C=$(curl -s -o /dev/null --max-time 3 -w "%{http_code}" "http://$LAN_IP/control/status" || true)
  { [ "$C" = 401 ] || [ "$C" = 200 ]; } && break
  sleep 2
done
{ [ "$C" = 401 ] || [ "$C" = 200 ]; } || { echo "AdGuard Home did not answer on http://$LAN_IP after its setup." >&2; kill $FIRST 2>/dev/null || true; exit 1; }

# The upstreams: written to a file only root can read, and sent with the login given to curl on standard input, so
# neither the password nor the body is ever on a command line.
UPJSON=$(printf '%s' "$UP" | awk -F, '{ for (i = 1; i <= NF; i++) { u = $i; sub(/#/, ":", u); printf "%s\"%s\"", (i > 1 ? "," : ""), u } }')
( umask 077; printf '{"upstream_dns":[%s]}' "$UPJSON" > /tmp/adguard-upstreams.json )
curl -fsS --max-time 30 -K - <<CURLCFG >/dev/null
url = "http://$LAN_IP/control/dns_config"
user = "admin:$PW"
header = "Content-Type: application/json"
data-binary = "@/tmp/adguard-upstreams.json"
CURLCFG
rm -f /tmp/adguard-upstreams.json
unset PW

# Hand over to systemd, which keeps it running and starts it at boot, reading the settings just written.
kill $FIRST; wait $FIRST 2>/dev/null || true
./AdGuardHome -s install >/dev/null
systemctl enable AdGuardHome >/dev/null 2>&1 || true
systemctl restart AdGuardHome
for i in $(seq 1 30); do
  C=$(curl -s -o /dev/null --max-time 3 -w "%{http_code}" "http://$LAN_IP/control/status" || true)
  { [ "$C" = 401 ] || [ "$C" = 200 ]; } && break
  sleep 2
done
{ [ "$C" = 401 ] || [ "$C" = 200 ]; } || { echo "AdGuard Home did not come back under systemd." >&2; journalctl -u AdGuardHome --no-pager -n 20 >&2 || true; exit 1; }
echo "AdGuard Home ` + ADGUARD_VERSION + String.raw` is serving DNS and its web page on $LAN_IP only, forwarding to $UP."`

// ── detection ───────────────────────────────────────────────────────────────

const json = (a: { status: number; body: string }): any => { if (a.status !== 200) return null; try { return JSON.parse(a.body) } catch { return null } }

/** Pi-hole v6's sign-in information answers without a login: its DNS flag, its HTTPS port and FTL's "took" timing. */
export const PIHOLE_DETECT: Fingerprint[] = [{
  path: '/api/info/login',
  match: a => { const j = json(a); return j && typeof j.dns === 'boolean' && typeof j.https_port === 'number' && typeof j.took === 'number' ? { version: null } : null },
}]

/**
 * AdGuard Home's login page names no product in its title; what is its own is the green Safari pin icon
 * (#67B279) and the login script it serves from the same folder. A set-up one answers it without a login.
 */
export const ADGUARD_LOGIN_RE = /rel="mask-icon" href="assets\/safari-pinned-tab\.svg" color="#67B279"[\s\S]*src="login\.[0-9a-f]+\.js"/
export const ADGUARD_DETECT: Fingerprint[] = [{
  path: '/login.html',
  match: a => (a.status === 200 && ADGUARD_LOGIN_RE.test(a.body) ? { version: null } : null),
}]

// ── the recipes ─────────────────────────────────────────────────────────────

export const POINT_NETWORK_NOTE = 'Nothing else on your network changes by itself. To use it everywhere, set the DNS server your router hands out by DHCP to this container\'s address (usually in the router\'s DHCP or LAN settings), then restart a device or renew its lease.'

export const PIHOLE_RECIPE: CatalogueRecipe = {
  id: PIHOLE_RECIPE_ID,
  detect: PIHOLE_DETECT,
  name: 'Pi-hole',
  summary: 'Blocks ads and trackers for every device on your network at the DNS level. The admin password is generated and kept in the vault, and the Pi-hole plug-in connects by itself.',
  category: 'network',
  port: 80,
  healthPath: '/api/info/login',
  expectStatus: [200],
  healthBody: { contains: ['"https_port"'] },
  needsDocker: true,
  defaults: { cores: 1, memoryMb: 512, diskGb: 6, swapMb: 256 },
  minimum: { cores: 1, memoryMb: 384, diskGb: 4 },
  firstRun: { kind: 'env-admin', user: 'admin', passwordEnv: 'PIHOLE_PASSWORD' },
  // Not offered to the AI assistant: it cannot hand the generated password back to the person who asked.
  wizard: false,
  firstLogin: 'Open its address and sign in with the generated password (shown once after the install, kept in the vault). Pi-hole has no user name, only a password.',
  notes: [
    `Pinned: Pi-hole ${PIHOLE_VERSION} (the official image, by tag and digest), in ${PIHOLE_DIR}/docker-compose.yml. An upgrade is a changed tag and digest, then \`docker compose up -d\`.`,
    'DNS (port 53) and the web page are published on this container\'s LAN address only, not on every interface.',
    POINT_NETWORK_NOTE,
    'The default block list is loaded and updates itself weekly; the plug-in can refresh it now.',
  ],
  options: DNS_OPTIONS,
  checkOptions: checkDnsOptions,
  pointNetwork: true,
  install: { kind: 'script', script: PIHOLE_SCRIPT },
}

export const ADGUARD_RECIPE: CatalogueRecipe = {
  id: ADGUARD_RECIPE_ID,
  detect: ADGUARD_DETECT,
  name: 'AdGuard Home',
  summary: 'Blocks ads and trackers for every device on your network at the DNS level. The admin password is generated and kept in the vault, and the AdGuard Home plug-in connects by itself.',
  category: 'network',
  port: 80,
  healthPath: '/login.html',
  expectStatus: [200],
  healthBody: { contains: ['safari-pinned-tab.svg', 'id="root"'] },
  needsDocker: false,
  defaults: { cores: 1, memoryMb: 512, diskGb: 4, swapMb: 256 },
  minimum: { cores: 1, memoryMb: 256, diskGb: 2 },
  firstRun: { kind: 'env-admin', user: 'admin', passwordEnv: 'ADGUARD_PASSWORD' },
  wizard: false,
  firstLogin: 'Open its address and sign in as admin with the generated password (shown once after the install, kept in the vault).',
  notes: [
    `Pinned: AdGuard Home ${ADGUARD_VERSION}, the release tarball checked against the project's published SHA-256, in ${ADGUARD_DIR}, run as a systemd service.`,
    'DNS (port 53) and the web page listen on this container\'s LAN address only, not on every interface.',
    POINT_NETWORK_NOTE,
    'AdGuard Home\'s default block list is loaded and refreshes itself; the plug-in can refresh it now.',
  ],
  options: DNS_OPTIONS,
  checkOptions: checkDnsOptions,
  pointNetwork: true,
  install: { kind: 'script', script: ADGUARD_SCRIPT },
}

export const DNS_BLOCKER_RECIPES: CatalogueRecipe[] = [PIHOLE_RECIPE, ADGUARD_RECIPE]
