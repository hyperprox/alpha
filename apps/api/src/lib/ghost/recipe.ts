// =============================================================================
//  HyperProx — the Ghost recipe: its compose file, install script and settings
//
//  Ghost runs from its Docker image with MySQL 8 beside it, in Compose, inside
//  an unprivileged Debian container. Debian 13 ships MariaDB, which Ghost does
//  not support in production, and Ghost-CLI wants Ubuntu, a non-root user and
//  prompts; the two pinned images are the cleanest way to the supported stack,
//  and an upgrade is a changed tag and `docker compose up -d`.
//
//  Four rules shape it:
//
//  Ghost listens on 127.0.0.1 only. The site's own nginx is the one thing on
//  the network, so its access log (the hyperprox_metrics format) sees every
//  request and Site metrics works with no changes.
//
//  The setup page is never open. Until HyperProx has made the owner (over the
//  container's loopback, lib/ghost/setup.ts) and read it back, nginx does not
//  proxy to Ghost at all: it serves a holding page (503). Only then is the Ghost
//  site turned on, and even then nginx refuses any write to the setup endpoint,
//  in every case, versioned or not, for good.
//
//  Secrets are files. The database passwords (and the SMTP password, when
//  there is one) are written to /opt/ghost/secrets, a folder only root can
//  open, and handed to the containers as Compose secrets that Ghost and MySQL
//  read through their *_FILE settings. They are never in an environment file,
//  a compose file or a command line.
//
//  The images are pinned to one release each by tag and digest, never `latest`.
// =============================================================================

import type { RecipeOption } from '../catalogue'
import { LOG_FORMAT_LINE } from '../site-metrics/log-format'

export const GHOST_RECIPE_ID = 'ghost'
/**
 * One Ghost release and one MySQL 8.4 LTS release, each by tag and by the digest of its multi-arch index, so the tag
 * cannot be moved under a site. Changing either is an upgrade, made on purpose.
 */
export const GHOST_VERSION = '6.77.0'
export const MYSQL_VERSION = '8.4.13'
export const GHOST_IMAGE = `ghost:${GHOST_VERSION}@sha256:2e3ca97643ea2a8cde6d0c97fae15ff39bfb60714f5abaab3f65263a2ed7c2a7`
export const MYSQL_IMAGE = `mysql:${MYSQL_VERSION}@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902`
export const GHOST_DIR = '/opt/ghost'
/** Where Ghost answers inside its container, published on the container's loopback only. */
export const GHOST_PORT = 2368

/** Said when there is no mail server, so nobody finds out from a lost invite. */
export const NO_MAIL = 'No mail server was given, so Ghost cannot send staff invites, password resets, member sign-up and sign-in links, or newsletters. The owner signs in with the password in the vault. Add SMTP later in /opt/ghost/ghost.env.'

export const GHOST_OPTIONS: RecipeOption[] = [
  { key: 'GHOST_TITLE', label: 'Site title', kind: 'text', required: true, default: 'My Ghost site', maxLength: 100 },
  { key: 'GHOST_DESCRIPTION', label: 'Description (optional)', kind: 'text', maxLength: 200, placeholder: 'Thoughts, stories and ideas' },
  { key: 'GHOST_OWNER_NAME', label: 'Owner name', kind: 'text', required: true, maxLength: 100, placeholder: 'Your name' },
  { key: 'GHOST_OWNER_EMAIL', label: 'Owner email', kind: 'email', required: true, maxLength: 120,
    hint: 'The owner signs in to /ghost with this address. The password is generated and kept in the vault.' },
  { key: 'GHOST_SMTP_HOST', label: 'SMTP server (optional)', kind: 'text', maxLength: 253, placeholder: 'smtp.example.com',
    hint: 'For staff invites, password resets and member sign-in links. Blank: Ghost sends no mail.' },
  { key: 'GHOST_SMTP_PORT', label: 'SMTP port', kind: 'number', default: '587', min: 1, max: 65535 },
  { key: 'GHOST_SMTP_SECURE', label: 'TLS from the start (port 465)', kind: 'boolean', default: '0',
    hint: 'Off uses STARTTLS, which port 587 expects.' },
  { key: 'GHOST_SMTP_USER', label: 'SMTP user (optional)', kind: 'text', maxLength: 200,
    hint: 'Its password is asked for below and kept in the vault, never in the plan.' },
  { key: 'GHOST_SMTP_FROM', label: 'Send mail from (optional)', kind: 'email', maxLength: 120, placeholder: 'noreply@example.com' },
  // Set by the preview only (a request's own value is dropped): the vault item holding the SMTP password until the install reads it.
  { key: 'GHOST_SMTP_REF', label: 'SMTP password reference', kind: 'text', maxLength: 40 },
]

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
/** An SMTP login name: what providers use (an address, "apikey", a key id), and nothing a settings file could misread. */
const SMTP_USER_RE = /^[A-Za-z0-9._%+@=-]{1,200}$/

/** Checks across the Ghost options, after each passed its own kind. */
export function checkGhostOptions(v: Record<string, string>): string[] {
  const out: string[] = []
  if (v.GHOST_SMTP_HOST && !HOST_RE.test(v.GHOST_SMTP_HOST)) out.push('SMTP server: a host name like smtp.example.com.')
  if (v.GHOST_SMTP_USER && !SMTP_USER_RE.test(v.GHOST_SMTP_USER)) out.push('SMTP user: letters, digits and . _ % + @ = - only.')
  if (!v.GHOST_SMTP_HOST && (v.GHOST_SMTP_USER || v.GHOST_SMTP_FROM)) out.push('An SMTP user or sender needs an SMTP server.')
  if (v.GHOST_OWNER_NAME && /[<>]/.test(v.GHOST_OWNER_NAME)) out.push('Owner name: no < or >.')
  return out
}

/** Whether these options turn mail on. */
export const mailWanted = (v: Record<string, string>) => Boolean(v.GHOST_SMTP_HOST)

/**
 * Turns the Ghost site on in nginx (after the owner exists): the real site in, the holding page out, checked by nginx -t,
 * reloaded. If the check fails the holding page stays. HyperProx reads the result back over HTTP afterwards.
 */
export const GHOST_OPEN_SCRIPT = [
  'set -e',
  '[ -f /etc/nginx/sites-available/ghost ]',
  'ln -sf /etc/nginx/sites-available/ghost /etc/nginx/sites-enabled/ghost',
  'rm -f /etc/nginx/sites-enabled/ghost-holding',
  'if ! nginx -t >/dev/null 2>&1; then',
  '  rm -f /etc/nginx/sites-enabled/ghost',
  '  ln -sf /etc/nginx/sites-available/ghost-holding /etc/nginx/sites-enabled/ghost-holding',
  '  echo "@@ghost nginx refused"; exit 1',
  'fi',
  'systemctl reload nginx',
  // A reload is not instant: the old workers serve the holding page for a moment. Wait until it is gone.
  'for i in $(seq 1 30); do',
  '  C=$(curl -s -o /dev/null --max-time 5 -w "%{http_code}" http://127.0.0.1/ghost/api/admin/site/ || true)',
  '  [ "$C" != 503 ] && [ "$C" != 000 ] && break',
  '  sleep 1',
  'done',
  'echo "@@ghost open"',
].join('\n')

/**
 * The compose file. Constant: everything that differs per site is in ghost.env (plain settings, already checked)
 * or in the secret files. Ghost waits for MySQL to be healthy, and publishes its port on loopback only.
 */
export function ghostCompose(): string {
  return `name: ghost
services:
  db:
    image: ${MYSQL_IMAGE}
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: ghost
      MYSQL_USER: ghost
      MYSQL_PASSWORD_FILE: /run/secrets/db_password
      MYSQL_ROOT_PASSWORD_FILE: /run/secrets/db_root_password
    secrets: [db_password, db_root_password]
    volumes:
      - ./mysql:/var/lib/mysql
    healthcheck:
      # Answers only once the real server is up: the first-start server runs with networking off.
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]
      interval: 5s
      timeout: 5s
      retries: 60
      start_period: 60s
  ghost:
    image: ${GHOST_IMAGE}
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "127.0.0.1:${GHOST_PORT}:${GHOST_PORT}"
    env_file: ./ghost.env
    environment:
      NODE_ENV: production
      database__client: mysql
      database__connection__host: db
      database__connection__user: ghost
      database__connection__database: ghost
      database__connection__password_FILE: /run/secrets/db_password
    secrets: [db_password, smtp_password]
    volumes:
      - ./content:/var/lib/ghost/content
secrets:
  db_password:
    file: ./secrets/db_password
  db_root_password:
    file: ./secrets/db_root_password
  smtp_password:
    file: ./secrets/smtp_password
`
}

/**
 * Ghost's own settings, one per line, from values that already passed their kinds and checkGhostOptions (a URL, a
 * host name, a port, an address), so none can break a line. Staff sign-in codes stay off until setup is done:
 * HyperProx signs in once to make its Admin API key, and a code could not be read. With mail they are turned on
 * straight after (lib/ghost/setup.ts); without mail they stay off, or the owner could be locked out by a code
 * that is never sent.
 */
export function ghostEnvFile(v: { url: string; smtpHost?: string; smtpPort?: string; smtpSecure?: string; smtpUser?: string; smtpFrom?: string }, verification = false): string {
  // Compose reads env_file values with ${...} interpolation and quotes; none of these may hold a $, a quote, a space,
  // a # or a line break, whatever checked them first.
  for (const [k, x] of Object.entries(v)) if (x !== undefined && !/^[A-Za-z0-9._%+@=:/\[\]-]*$/.test(x)) throw new Error(`Ghost's ${k} holds a character its settings file cannot carry.`)
  const lines = [`url=${v.url}`, `security__staffDeviceVerification=${verification ? 'true' : 'false'}`]
  if (v.smtpHost) {
    lines.push('mail__transport=SMTP', `mail__options__host=${v.smtpHost}`, `mail__options__port=${v.smtpPort || '587'}`,
      `mail__options__secure=${v.smtpSecure === '1' ? 'true' : 'false'}`)
    if (v.smtpUser) lines.push(`mail__options__auth__user=${v.smtpUser}`, 'mail__options__auth__pass_FILE=/run/secrets/smtp_password')
    if (v.smtpFrom) lines.push(`mail__from=${v.smtpFrom}`)
  }
  return lines.join('\n') + '\n'
}

/** Headers for a Ghost site. Ghost sets its own framing and caching rules, so only these are added. */
const GHOST_HEADERS = String.raw`add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()" always;`

/**
 * What nginx serves while Ghost is being set up: a 503 for everything, never a proxy to Ghost, so nobody can reach its
 * setup before HyperProx has made the owner. Logged in the metrics format like the site itself.
 */
export const GHOST_HOLDING_NGINX = String.raw`server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  server_tokens off;
  access_log /var/log/nginx/access.log hyperprox_metrics;
  location / {
    default_type text/plain;
    return 503 "This site is being set up.
";
  }
}`

/**
 * Any path Ghost's router would take as its setup endpoint: Express matches case-insensitively and Ghost accepts a
 * version segment (/ghost/api/v4/admin/...), so this is a case-insensitive regex with an optional segment. nginx has
 * already merged slashes and resolved dot segments and percent-encoding before it matches.
 */
export const SETUP_LOCATION_RE = String.raw`^/ghost/api/(?:[^/]+/)?admin/authentication/setup`

/**
 * The site's nginx, turned on only after the owner exists (lib/ghost/setup.ts ghost-open). It logs in the
 * hyperprox_metrics format, refuses every write to the setup endpoint for good, and passes the visitor's scheme as https when the site's address is https (it always sits
 * behind the HTTPS proxy then), so Ghost never redirects in a loop. @XFP@ is filled in by the script. proxy_pass sits
 * in the server block itself (not an include), so site discovery reads it as a proxied site.
 */
export const GHOST_NGINX = String.raw`server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  server_tokens off;
  client_max_body_size 64m;
  access_log /var/log/nginx/access.log hyperprox_metrics;
  include snippets/site-headers.conf;

  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto @XFP@;
  proxy_set_header Connection "";
  proxy_read_timeout 120s;

  # Ghost's owner is made by HyperProx over the container's loopback. Nobody on the network can write to its setup,
  # in any case and under any API version.
  location ~* ` + SETUP_LOCATION_RE + String.raw` {
    limit_except GET HEAD { deny all; }
    proxy_pass http://127.0.0.1:` + GHOST_PORT + String.raw`;
  }
  location / {
    proxy_pass http://127.0.0.1:` + GHOST_PORT + String.raw`;
  }
}`

export const GHOST_SCRIPT = (String.raw`# The installer runs scripts under umask 077; nginx must be able to read its own files.
umask 022
# The generated secrets stay in this shell. The owner's password is not used here at all: HyperProx creates the owner
# through Ghost's own setup API after this script, over the container's loopback.
DB_PW="$GHOST_DB_PASSWORD"; DB_ROOT_PW="$GHOST_DB_ROOT_PASSWORD"; SMTP_PW="$GHOST_SMTP_PASSWORD"
unset GHOST_ADMIN_PASSWORD GHOST_DB_PASSWORD GHOST_DB_ROOT_PASSWORD GHOST_SMTP_PASSWORD
if [ -z "$DB_PW" ] || [ -z "$DB_ROOT_PW" ]; then echo "The installer did not pass the generated passwords." >&2; exit 1; fi
if [ -z "$GHOST_URL" ]; then echo "The installer did not pass the site's address." >&2; exit 1; fi
if [ -n "$GHOST_SMTP_USER" ] && [ -z "$SMTP_PW" ]; then echo "An SMTP user was given without its password." >&2; exit 1; fi

apt-get update -qq
apt-get install -y -qq ca-certificates curl docker.io docker-compose nginx
systemctl enable --now docker

D=` + GHOST_DIR + String.raw`
mkdir -p $D/secrets $D/content $D/mysql
chmod 700 $D/secrets
# The secret files: written by the shell (printf is a builtin, so no value is on a command line), readable inside the
# folder only root can open. The containers read them as their own users through Compose secrets.
( umask 077
  printf '%s' "$DB_PW" > $D/secrets/db_password
  printf '%s' "$DB_ROOT_PW" > $D/secrets/db_root_password
  printf '%s' "$SMTP_PW" > $D/secrets/smtp_password )
chmod 444 $D/secrets/db_password $D/secrets/db_root_password $D/secrets/smtp_password
if [ -s $D/mysql/ibdata1 ]; then
  echo "This container already has a Ghost database; its passwords were set when it was made, so they are kept." >&2
  echo "Run the install in a new container instead." >&2
  exit 1
fi

cat > $D/docker-compose.yml <<'HP_COMPOSE'
@COMPOSE@HP_COMPOSE

# Ghost's settings (lib/ghost/recipe.ts ghostEnvFile): plain values, each already checked by HyperProx.
if [ -z "$GHOST_ENV_FILE" ]; then echo "The installer did not pass Ghost's settings." >&2; exit 1; fi
( umask 077; printf '%s' "$GHOST_ENV_FILE" > $D/ghost.env )

cd $D
# --quiet-pull keeps progress bars out of the output, so a failure's last lines are the error.
docker compose up -d --quiet-pull
echo "Ghost ` + GHOST_VERSION + String.raw` and MySQL ` + MYSQL_VERSION + String.raw` are starting (Ghost on 127.0.0.1:` + GHOST_PORT + String.raw` only)."

cat > /etc/nginx/conf.d/hyperprox-metrics-log.conf <<'NGINX'
# HyperProx site metrics: combined + $request_time + X-Forwarded-For.
` + LOG_FORMAT_LINE + String.raw`
NGINX
cat > /etc/nginx/snippets/site-headers.conf <<'NGINX'
` + GHOST_HEADERS + String.raw`
NGINX
# Behind the HTTPS proxy, Ghost must hear https or it redirects in a loop; a site on the LAN only passes the real scheme.
case "$GHOST_URL" in https://*) XFP=https ;; *) XFP='$scheme' ;; esac
cat > /etc/nginx/sites-available/ghost <<'NGINX'
` + GHOST_NGINX + String.raw`
NGINX
sed -i "s|@XFP@|$XFP|" /etc/nginx/sites-available/ghost
# Not turned on yet: until HyperProx has made the owner, nginx serves only the holding page.
cat > /etc/nginx/sites-available/ghost-holding <<'NGINX'
` + GHOST_HOLDING_NGINX + String.raw`
NGINX
rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/ghost
ln -sf /etc/nginx/sites-available/ghost-holding /etc/nginx/sites-enabled/ghost-holding
nginx -t
systemctl enable nginx
systemctl reload-or-restart nginx
echo "nginx is serving a holding page on port 80; Ghost is not reachable from the network until its owner exists."`).replace('@COMPOSE@', () => ghostCompose())
