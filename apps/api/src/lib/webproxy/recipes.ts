// =============================================================================
//  HyperProx — the web proxies' Catalogue recipes: NGINX, Caddy, Envoy
//
//  Each installs one pinned version straight from the project's own source for
//  Debian 13, with no Docker:
//    NGINX   the mainline package from nginx.org's own apt repository
//    Caddy   the package from Caddy's own apt repository (Cloudsmith)
//    Envoy   the release binary from Envoy's GitHub release, checked against
//            the SHA-256 the release publishes (Envoy's apt repository stops
//            at Debian 12 and an old version)
//  A repository key is accepted only when its fingerprint is the one written
//  here; a download only when its checksum is.
//
//  Every admin and status interface listens on the container's loopback only:
//  NGINX's status page on 127.0.0.1:8081, Caddy's admin API on 127.0.0.1:2019,
//  Envoy's admin on 127.0.0.1:9901. HyperProx reaches them through the
//  container (the remote executor), never over the network.
//
//  NGINX and Caddy go on the Proxy page when they answer (registersProxy), so
//  apps can be published through them from HyperProx. Envoy has no provider:
//  its plug-in reads and acts on it, and its routes stay in its own files.
// =============================================================================

import type { CatalogueRecipe } from '../catalogue'
import { DETECT } from '../catalogue-detect'
import { NGINX_HEADER, NGINX_HOSTS_FILE } from '../proxy/providers/nginx'

export const NGINX_VERSION = '1.31.8'
export const CADDY_VERSION = '2.11.7'
export const ENVOY_VERSION = '1.40.2'

/** nginx.org's signing key, as nginx.org lists it (nginx.org/en/linux_packages.html). */
export const NGINX_KEY_FPR = '573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62'
/** Every fingerprint nginx.org's key file holds (its three signing keys). Any other key in the file refuses the install. */
export const NGINX_KEY_ALLOW = ['8540A6F18833A80E9C1653A42FD21310B49F6B46', NGINX_KEY_FPR, '9E9BE90EACBCDE69FE9B204CBCDCD8A38D88A2B3']
/** Caddy's Cloudsmith repository key. */
export const CADDY_KEY_FPR = '65760C51EDEA2017CEA2CA15155B6D79CA56EA34'
/** Every fingerprint Caddy's key file holds (the key and its subkeys). */
export const CADDY_KEY_ALLOW = [CADDY_KEY_FPR, '15136FB52CCAE0C37FD951B45884A18B779C85D1', 'D59FC5219C50B989D95FCE4E531A6B20FA058A70', '2F5C3BE9886ACD2913299EFBABA1F9B8875A6661']
/** The SHA-256 Envoy's release lists for each binary. */
export const ENVOY_SHA256: Record<'amd64' | 'arm64', string> = {
  amd64: '1d64506e25c1844f146162ddb2ece7010fa4e784faddb40a079021491f1f03cc',
  arm64: 'b9d6d1e06dd5838a3506de9f4deebad3de9a2ce6cadb87cd76222ca286213baf',
}

export const NGINX_STATUS = 'http://127.0.0.1:8081/nginx_status'
export const CADDY_ADMIN = 'http://127.0.0.1:2019'
export const ENVOY_ADMIN = 'http://127.0.0.1:9901'
/** The path each proxy's own health answer lives on (the installer's check, and a load balancer's). */
export const HEALTH_PATH = '/hpx-healthz'

/**
 * The repository key, checked by fingerprint before apt trusts it. `$1` is the key URL, `$2` the fingerprint that must
 * be there, `$3` the keyring, the rest every fingerprint the file may hold: a key file with any other key in it (an
 * added key would be trusted for the whole repository) is refused.
 */
const KEY_CHECK = String.raw`hpx_key() {
  url=$1; want=$2; ring=$3; shift 3
  curl -fsSL "$url" -o /tmp/hpx-repo.key
  fprs=$(gpg --show-keys --with-colons /tmp/hpx-repo.key 2>/dev/null | awk -F: '/^fpr/{print $10}')
  if ! printf '%s
' "$fprs" | grep -qx "$want"; then
    echo "The repository key at $url is not the one HyperProx expects ($want). Nothing was installed."
    exit 1
  fi
  for f in $fprs; do
    case " $* " in *" $f "*) ;; *) echo "The key file at $url holds a key HyperProx does not know ($f). Nothing was installed."; exit 1 ;; esac
  done
  gpg --dearmor < /tmp/hpx-repo.key > "$ring"
  chmod 0644 "$ring"
  rm -f /tmp/hpx-repo.key
}`

const DEBIAN_13 = String.raw`. /etc/os-release
if [ "$ID" != debian ] || [ "$VERSION_CODENAME" != trixie ]; then
  echo "This recipe installs on Debian 13 (trixie); this container is $PRETTY_NAME."
  exit 1
fi`

export const NGINX_SCRIPT = String.raw`umask 022
` + DEBIAN_13 + String.raw`
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates debian-archive-keyring openssl
` + KEY_CHECK + String.raw`
hpx_key https://nginx.org/keys/nginx_signing.key ${NGINX_KEY_FPR} /usr/share/keyrings/nginx-archive-keyring.gpg ${NGINX_KEY_ALLOW.join(' ')}
echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] https://nginx.org/packages/mainline/debian trixie nginx" > /etc/apt/sources.list.d/nginx.list
# nginx.org's packages win over Debian's, so an upgrade stays on nginx.org's mainline.
printf 'Package: *\nPin: origin nginx.org\nPin: release o=nginx\nPin-Priority: 900\n' > /etc/apt/preferences.d/99nginx
apt-get update -qq
apt-get install -y -qq "nginx=${NGINX_VERSION}-1~trixie"

# The default site: a health answer, and 404 for any name nothing serves.
cat > /etc/nginx/conf.d/default.conf <<'NGINX'
server {
  listen 80 default_server;
  server_name _;
  location = ${HEALTH_PATH} { access_log off; default_type text/plain; return 200 "ok\n"; }
  location / { return 404; }
}
NGINX
# The status page HyperProx reads: loopback only, inside the container.
cat > /etc/nginx/conf.d/hyperprox-status.conf <<'NGINX'
server {
  listen 127.0.0.1:8081;
  server_name localhost;
  access_log off;
  location = /nginx_status { stub_status; allow 127.0.0.1; deny all; }
  location / { return 404; }
}
NGINX
# HyperProx's own server file (the Proxy page writes it; every change is checked with nginx -t first).
[ -e ${NGINX_HOSTS_FILE} ] || printf '%s\n' '${NGINX_HEADER}' > ${NGINX_HOSTS_FILE}
nginx -t
systemctl enable nginx
systemctl restart nginx
echo "NGINX $(nginx -v 2>&1 | sed 's/.*nginx\///') is serving on port 80."`

/** What the Debian package's Caddyfile unit leaves in autosave.json on its first start (its welcome page). */
const CADDY_PACKAGE_DEFAULT = '{"apps":{"http":{"servers":{"srv0":{"listen":[":80"],"routes":[{"handle":[{"handler":"vars","root":"/usr/share/caddy"},{"handler":"file_server","hide":["/etc/caddy/Caddyfile"]}]}]}}}}}'

export const CADDY_SCRIPT = String.raw`umask 022
` + DEBIAN_13 + String.raw`
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates debian-archive-keyring openssl
` + KEY_CHECK + String.raw`
hpx_key https://dl.cloudsmith.io/public/caddy/stable/gpg.key ${CADDY_KEY_FPR} /usr/share/keyrings/caddy-stable-archive-keyring.gpg ${CADDY_KEY_ALLOW.join(' ')}
echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq "caddy=${CADDY_VERSION}"

# HyperProx drives Caddy through its admin API, so Caddy runs the API unit (caddy run --resume: changes made
# through the API survive a restart) instead of the Caddyfile one.
systemctl disable --now caddy
systemctl enable caddy-api
systemctl restart caddy-api
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:2019/config/ 2>/dev/null && break; sleep 1; done
# First start only: one HTTP server on 80 and 443 with automatic HTTPS, a health answer, and the admin API on the
# container's loopback. The package's own unit started once with its welcome page, which caddy-api resumed; that
# exact configuration (or none) is replaced. A Caddy with any other configuration keeps it.
cur=$(curl -fsS http://127.0.0.1:2019/config/)
if [ "$cur" = "null" ] || [ "$cur" = '${CADDY_PACKAGE_DEFAULT}' ]; then
  curl -fsS -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:2019/load <<'JSON'
{"admin":{"listen":"127.0.0.1:2019"},"apps":{"http":{"servers":{"srv0":{"listen":[":80",":443"],"routes":[
{"@id":"hpx-health","match":[{"path":["${HEALTH_PATH}"]}],"handle":[{"handler":"static_response","status_code":200,"body":"ok\n"}],"terminal":true}
]}}}}}
JSON
fi
for i in $(seq 1 15); do curl -fsS -o /dev/null http://127.0.0.1:2019/config/ 2>/dev/null && break; sleep 1; done
echo "Caddy $(caddy version | cut -d' ' -f1) is serving on ports 80 and 443; its admin API is on 127.0.0.1:2019 only."`

const ENVOY_BOOTSTRAP = String.raw`node: { id: hyperprox-envoy, cluster: hyperprox }
admin:
  address: { socket_address: { address: 127.0.0.1, port_value: 9901 } }
dynamic_resources:
  lds_config:
    resource_api_version: V3
    path_config_source:
      path: /etc/envoy/dynamic/lds.yaml
      watched_directory: { path: /etc/envoy/dynamic }
  cds_config:
    resource_api_version: V3
    path_config_source:
      path: /etc/envoy/dynamic/cds.yaml
      watched_directory: { path: /etc/envoy/dynamic }`

const ENVOY_LDS = String.raw`resources:
- "@type": type.googleapis.com/envoy.config.listener.v3.Listener
  name: http
  address: { socket_address: { address: 0.0.0.0, port_value: 80 } }
  filter_chains:
  - filters:
    - name: envoy.filters.network.http_connection_manager
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
        stat_prefix: ingress_http
        route_config:
          name: local
          virtual_hosts:
          - name: default
            domains: ["*"]
            routes:
            - match: { prefix: "/" }
              direct_response: { status: 404, body: { inline_string: "No route here.\n" } }
        http_filters:
        - name: envoy.filters.http.health_check
          typed_config:
            "@type": type.googleapis.com/envoy.extensions.filters.http.health_check.v3.HealthCheck
            pass_through_mode: false
            headers: [{ name: ":path", string_match: { exact: "${HEALTH_PATH}" } }]
        - name: envoy.filters.http.router
          typed_config: { "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router }`

export const ENVOY_SCRIPT = String.raw`umask 022
` + DEBIAN_13 + String.raw`
apt-get update -qq
apt-get install -y -qq curl ca-certificates
case "$(dpkg --print-architecture)" in
  amd64) a=x86_64; sum=${ENVOY_SHA256.amd64} ;;
  arm64) a=aarch_64; sum=${ENVOY_SHA256.arm64} ;;
  *) echo "Envoy publishes binaries for amd64 and arm64 only."; exit 1 ;;
esac
curl -fsSL -o /tmp/envoy "https://github.com/envoyproxy/envoy/releases/download/v${ENVOY_VERSION}/envoy-${ENVOY_VERSION}-linux-$a"
if ! echo "$sum  /tmp/envoy" | sha256sum -c --quiet -; then
  echo "The Envoy download does not match the checksum its release publishes. Nothing was installed."
  rm -f /tmp/envoy; exit 1
fi
install -m 0755 /tmp/envoy /usr/local/bin/envoy
rm -f /tmp/envoy
id envoy >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin envoy
mkdir -p /etc/envoy/dynamic
# Listeners and clusters live in watched files: a change is moved into place and Envoy picks it up without a restart.
cat > /etc/envoy/envoy.yaml <<'YAML'
${ENVOY_BOOTSTRAP}
YAML
[ -e /etc/envoy/dynamic/lds.yaml ] || cat > /etc/envoy/dynamic/lds.yaml <<'YAML'
${ENVOY_LDS}
YAML
[ -e /etc/envoy/dynamic/cds.yaml ] || printf 'resources: []\n' > /etc/envoy/dynamic/cds.yaml
/usr/local/bin/envoy --mode validate -c /etc/envoy/envoy.yaml --log-level warn
cat > /etc/systemd/system/envoy.service <<'UNIT'
[Unit]
Description=Envoy proxy
After=network-online.target
Wants=network-online.target

[Service]
User=envoy
Group=envoy
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/envoy -c /etc/envoy/envoy.yaml --log-level warn
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
# Envoy only reads its files and binds its ports: everything else is taken away.
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable envoy
systemctl restart envoy
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:9901/ready 2>/dev/null && break; sleep 1; done
echo "Envoy $(/usr/local/bin/envoy --version | grep -o 'version: [^ ]*' | cut -d/ -f2) is serving on port 80; its admin is on 127.0.0.1:9901 only."`

const base = {
  category: 'proxy' as const, needsDocker: false, firstRun: { kind: 'none' as const }, wizard: false,
  healthPath: HEALTH_PATH, expectStatus: [200],
}

export const WEB_PROXY_RECIPES: CatalogueRecipe[] = [
  {
    ...base,
    id: 'nginx',
    detect: DETECT['nginx'],
    name: 'NGINX',
    summary: 'The web server, reverse proxy, cache and load balancer (mainline). HyperProx publishes apps through it from the Proxy page and watches it with its own plug-in.',
    port: 80,
    defaults: { cores: 1, memoryMb: 512, diskGb: 4, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 256, diskGb: 2 },
    registersProxy: 'nginx',
    // Its default site answers the health path with "ok" (an error page could still be a 200).
    healthBody: { contains: ['ok'] },
    notes: [
      `NGINX ${NGINX_VERSION} mainline from nginx.org’s own Debian repository, on Debian 13. Takes port 80 on this container.`,
      `HyperProx writes ${NGINX_HOSTS_FILE} for the hosts you publish from the Proxy page; every change is checked with nginx -t before NGINX reloads. Your own sites go in other files there.`,
      'Its status page listens on 127.0.0.1:8081 inside the container only; the NGINX plug-in reads it through the container.',
    ],
    install: { kind: 'script', script: NGINX_SCRIPT },
  },
  {
    ...base,
    id: 'caddy',
    detect: DETECT['caddy'],
    name: 'Caddy',
    summary: 'A reverse proxy with automatic HTTPS. HyperProx publishes apps through it from the Proxy page and watches its routes, upstreams and certificates with its own plug-in.',
    port: 80,
    defaults: { cores: 1, memoryMb: 512, diskGb: 4, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 256, diskGb: 2 },
    registersProxy: 'caddy',
    // Its default site answers the health path with "ok" (an error page could still be a 200).
    healthBody: { contains: ['ok'] },
    notes: [
      `Caddy ${CADDY_VERSION} from Caddy’s own Debian repository, on Debian 13. Takes ports 80 and 443 on this container.`,
      'Its admin API listens on 127.0.0.1:2019 inside the container only; HyperProx reaches it through the container. It is never exposed.',
      'Point your router’s ports 80 and 443 at this container so Caddy can get certificates for the names you publish.',
    ],
    install: { kind: 'script', script: CADDY_SCRIPT },
  },
  {
    ...base,
    id: 'envoy',
    // Envoy's health-check filter answers 200 with an empty body (503 when drained): the status is the answer.
    detect: DETECT['envoy'],
    name: 'Envoy',
    summary: 'An edge and service proxy. Its plug-in shows clusters and their health, listeners and request and error rates, and can drain it or reload its configuration.',
    port: 80,
    defaults: { cores: 1, memoryMb: 512, diskGb: 4, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 256, diskGb: 2 },
    notes: [
      `Envoy ${ENVOY_VERSION}, the release binary checked against the checksum Envoy publishes, on Debian 13. Takes port 80 on this container.`,
      'Listeners and clusters are in /etc/envoy/dynamic (lds.yaml, cds.yaml); a change moved into place is picked up without a restart.',
      'Its admin listens on 127.0.0.1:9901 inside the container only; the Envoy plug-in reads it through the container.',
      'Not on the Proxy page: Envoy’s routes stay in its own files.',
    ],
    install: { kind: 'script', script: ENVOY_SCRIPT },
  },
]
