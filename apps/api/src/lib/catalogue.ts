// =============================================================================
//  HyperProx — the service catalogue
//
//  HyperProx integrates with things you already run. This is the answer to
//  "what if I do not run one?" — a reverse proxy for the proxy features, an
//  Ollama for the AI wizard, a Tautulli for Plex history. Each recipe knows
//  what it satisfies, so once it is up the integration is configured rather
//  than left as an address to copy.
//
//  Two rules shaped every recipe here.
//
//  Bind to the world, not to localhost. A service reachable only on 127.0.0.1
//  inside its own container is invisible to HyperProx, and the failure looks
//  like a network problem rather than a default. Ollama in particular ships
//  bound to loopback and is the most common "why can't it see my model server".
//
//  Say what the first login is. A recipe that installs a service and does not
//  tell you its default credentials has handed you a locked box.
// =============================================================================

import { DETECT, type Fingerprint } from './catalogue-detect'
import { LOG_FORMAT_LINE } from './site-metrics/log-format'
import type { Distro } from './install-script'
import { PBS_OPTIONS, PBS_SCRIPT, NOT_OFFSITE, checkPbsOptions, RECIPE_ID as PBS_RECIPE_ID } from './pbs/catalogue'

/** What a person does the first time they open the service. */
export type FirstRun =
  | { kind: 'none' }
  | { kind: 'setup-url'; path: string }
  | {
      kind: 'env-admin'; userEnv?: string; passwordEnv: string; user: string
      /** The option whose value is the admin user name, when the person chooses it; `user` is the fallback. */
      userOption?: string
      /**
       * More secrets the installer generates, passed in these variables and kept in the same vault item
       * under these keys. They are never shown on the install page; the vault reveals them.
       */
      secrets?: Array<{ env: string; vaultKey: string }>
    }

export type RecipeCategory = 'proxy' | 'ai' | 'media' | 'monitoring' | 'apps' | 'web'

/**
 * A setting the person fills in before the install. Its key is also the environment variable the
 * install script reads, so every value is checked against its kind before it gets near a script.
 */
export interface RecipeOption {
  key:       string
  label:     string
  hint?:     string
  /**
   * text: one line, printable. url: an https:// address with no user name or password in it. email.
   * username: lowercase letters, digits, dot, dash, underscore. gitref: a branch or tag name. path: a
   * relative folder with no "..". number: a whole number between min and max. boolean: "1" or "0".
   */
  kind:      'text' | 'url' | 'email' | 'username' | 'gitref' | 'path' | 'number' | 'boolean'
  required?: boolean
  default?:  string
  min?:      number
  max?:      number
  maxLength?: number
  placeholder?: string
}

export interface CatalogueRecipe {
  id:          string
  name:        string
  /** One line: what it is, in the reader's terms. */
  summary:     string
  category:    RecipeCategory
  /** The plug-in or integration this satisfies once installed. */
  satisfies?:  { kind: 'plugin' | 'credential'; id: string; setting: string }
  /** Port the service answers on, used for the integration URL and the check. */
  port:        number
  /** Path that proves it is actually serving, not merely listening. */
  healthPath:  string
  /** Statuses that count as serving at healthPath. */
  expectStatus: number[]
  /**
   * What the page at healthPath must (and must not) contain, for a service whose status alone proves too
   * little: a PHP page served as source, or an error page, can still be a 200.
   */
  healthBody?: { contains: string[]; absent?: string[] }
  /** Settings asked for in the wizard and passed to the install script by key. */
  options?:    RecipeOption[]
  /** Runs under Docker, in an unprivileged container with nesting only. */
  needsDocker: boolean
  /** What the wizard pre-fills: the recommended size. */
  defaults:    { cores: number; memoryMb: number; diskGb: number; swapMb?: number }
  /** Size presets the New website wizard offers; the person can still change each number. */
  sizes?:      Record<'small' | 'medium' | 'large', { cores: number; memoryMb: number; diskGb: number }>
  /** Below this it may not start or will struggle; the wizard warns, it does not refuse. */
  minimum:     { cores: number; memoryMb: number; diskGb: number }
  /** Needs a GPU on its node. Placement otherwise keeps GPU nodes free. */
  needsGpu?:   boolean
  /** Works better with any GPU, integrated included (hardware transcoding). Placement prefers one. */
  wantsGpu?:   boolean
  /** Shown before anything runs, so the choice is informed. */
  firstLogin?: string
  notes?:      string[]
  firstRun:    FirstRun
  /** Offered to the AI wizard, which installs only recipes with this set. */
  wizard:      boolean
  install:
    | { kind: 'compose'; dir: string; compose: string }
    | { kind: 'script'; script: string }
  /** Extra packages on top of DOCKER_PACKAGES, by distro. */
  packages?:   Partial<Record<Distro, string[]>>
  /**
   * The environment variable a service reads the Host headers it answers from. The installer sets it to
   * the container's address and port (what the health check sends) and, when published, the domain.
   */
  allowedHostsEnv?: string
  /**
   * How to tell this app is already running somewhere (lib/catalogue-detect.ts): read-only GETs of a path only
   * it answers that way. Without one (or a kind site discovery reads), the catalogue cannot see an install.
   */
  detect?:     Fingerprint[]
  /**
   * A recipe with its own guided setup after the install, in place of the generic health check and wiring
   * (lib/pbs/catalogue.ts for Proxmox Backup Server: datastore location, tokens, plug-in, optional storage).
   */
  setup?:      'pbs'
  /** Checks across the recipe's options, after each one passed its own kind. */
  checkOptions?: (values: Record<string, string>) => string[]
}

// ── Web hosting scripts ─────────────────────────────────────────────────────
//  String.raw keeps nginx's regex backslashes; the scripts never use ${...}, so nothing in them is
//  interpolated here. Every value they read arrives as an environment variable the installer exported,
//  already checked against its option's kind. Secrets reach commands only on standard input (here
//  strings and heredocs), never as arguments, which any process in the container could read.

/** Security headers, included at server level and again wherever a location adds its own headers. */
const SECURITY_HEADERS = String.raw`add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;`

const GZIP = String.raw`  gzip on;
  gzip_vary on;
  gzip_proxied any;
  gzip_comp_level 5;
  gzip_min_length 256;
  gzip_types text/plain text/css text/xml text/javascript application/javascript application/json
             application/xml application/rss+xml application/atom+xml application/manifest+json
             image/svg+xml font/ttf font/otf application/vnd.ms-fontobject;`

/** Asset types that get the long cache; HTML is never among them, so a pull shows at once. */
const ASSET_EXT = String.raw`css|js|mjs|map|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|mp4|webm|pdf`

/**
 * The access log format both web recipes use (lib/site-metrics/log-format.ts): nginx's combined format plus the
 * request time and the proxy's X-Forwarded-For, so the Metrics tab has response times and can tell visitors apart
 * behind the proxy. conf.d is included before sites-enabled, so the format exists before the site uses it.
 */
const METRICS_LOG_FORMAT = String.raw`cat > /etc/nginx/conf.d/hyperprox-metrics-log.conf <<'NGINX'
# HyperProx site metrics: combined + $request_time + X-Forwarded-For.
` + LOG_FORMAT_LINE + String.raw`
NGINX`

export const STATIC_SITE_SCRIPT = String.raw`# The installer runs scripts under umask 077; nginx's workers must be able to read what is written here.
umask 022
apt-get update -qq
apt-get install -y -qq nginx git rsync ca-certificates
[ -n "$SITE_BRANCH" ] || SITE_BRANCH=main
[ -n "$SITE_PULL_MINUTES" ] || SITE_PULL_MINUTES=0

# The settings site-pull reads, quoted by printf so sourcing them runs nothing.
mkdir -p /etc/hyperprox /var/lib/site /var/www/site
{
  printf 'SITE_REPO=%q\n' "$SITE_REPO"
  printf 'SITE_BRANCH=%q\n' "$SITE_BRANCH"
  printf 'SITE_DIR=%q\n' "$SITE_DIR"
} > /etc/hyperprox/site.env

cat > /usr/local/bin/site-pull <<'PULL'
#!/bin/bash
# Pull the site from its git repository and publish it to /var/www/site.
# Run it any time ("Pull now"); the timer, when one is set, runs the same thing.
set -euo pipefail
. /etc/hyperprox/site.env
if [ -z "$SITE_REPO" ]; then
  echo "No git repository is set for this site, so there is nothing to pull."
  exit 0
fi
exec 9>/var/lib/site/pull.lock
flock -n 9 || { echo "A pull is already running."; exit 0; }
SRC=/var/lib/site/src
mkdir -p "$SRC"
[ -d "$SRC/.git" ] || git -C "$SRC" init -q
git -C "$SRC" remote remove origin 2>/dev/null || true
git -C "$SRC" remote add origin "$SITE_REPO"
GIT_TERMINAL_PROMPT=0 git -C "$SRC" fetch -q --depth 1 origin "$SITE_BRANCH"
git -C "$SRC" checkout -q -f -B site FETCH_HEAD
git -C "$SRC" clean -q -fdx
FROM="$SRC/$SITE_DIR"
if [ ! -d "$FROM" ]; then
  echo "The repository has no folder called $SITE_DIR on $SITE_BRANCH."
  exit 1
fi
rsync -a --delete --delay-updates --exclude '.git' --chmod=D755,F644 "$FROM/" /var/www/site/
echo "Published $(git -C "$SRC" rev-parse --short HEAD) from $SITE_BRANCH."
PULL
chmod 755 /usr/local/bin/site-pull

cat > /etc/systemd/system/site-pull.service <<'UNIT'
[Unit]
Description=Pull the static site from git
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/site-pull
NoNewPrivileges=yes
PrivateTmp=yes
UNIT

# The timer is written only when an interval is set; 0 removes it.
if [ "$SITE_PULL_MINUTES" -gt 0 ]; then
  cat > /etc/systemd/system/site-pull.timer <<UNIT
[Unit]
Description=Pull the static site from git every $SITE_PULL_MINUTES minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=$SITE_PULL_MINUTES min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now site-pull.timer
else
  systemctl disable --now site-pull.timer 2>/dev/null || true
  rm -f /etc/systemd/system/site-pull.timer
  systemctl daemon-reload
fi

if [ -n "$SITE_REPO" ]; then
  /usr/local/bin/site-pull
elif [ -z "$(ls -A /var/www/site)" ]; then
  # A starter page only when the folder is empty: files put there by hand are never overwritten.
  [ -n "$SITE_TITLE" ] || SITE_TITLE="My site"
  TITLE=$(printf '%s' "$SITE_TITLE" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g')
  printf '%s\n' '<!doctype html>' \
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' \
    "<title>$TITLE</title></head>" \
    '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.6">' \
    "<h1>$TITLE</h1>" \
    '<p>This site is ready. Put its HTML, CSS and JavaScript in <code>/var/www/site</code>, or set a git repository and run <code>site-pull</code>.</p>' \
    '</body></html>' > /var/www/site/index.html
fi

` + METRICS_LOG_FORMAT + String.raw`
cat > /etc/nginx/snippets/site-headers.conf <<'NGINX'
` + SECURITY_HEADERS + String.raw`
NGINX

cat > /etc/nginx/sites-available/site <<'NGINX'
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  root /var/www/site;
  index index.html index.htm;
  charset utf-8;
  server_tokens off;
  access_log /var/log/nginx/access.log hyperprox_metrics;
  include snippets/site-headers.conf;
` + GZIP + String.raw`

  location / {
    try_files $uri $uri/ $uri.html =404;
    add_header Cache-Control "no-cache";
    include snippets/site-headers.conf;
  }
  # Dot files (.git, .env and the like) are never served; .well-known is.
  location ~ /\.(?!well-known/) { return 404; }
  # Assets keep for 30 days: give changed files a new name (or ?v=2) so browsers fetch them again.
  location ~* \.(?:` + ASSET_EXT + String.raw`)$ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=2592000";
    include snippets/site-headers.conf;
    access_log off;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/site /etc/nginx/sites-enabled/site
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload-or-restart nginx
echo "nginx is serving /var/www/site on port 80."`

/**
 * The must-use plug-in the WordPress recipe installs. It answers only a POST to wp-login.php?action=hyperprox,
 * deletes the stored hash before it compares (one try, right or wrong), and signs in only an administrator.
 */
export const WP_LOGIN_MU_PLUGIN = String.raw`<?php
/*
 * Plugin Name: HyperProx one-time sign-in
 * Description: Lets HyperProx open wp-admin for you with a link that works once, for 60 seconds.
 */
add_action('login_form_hyperprox', function () {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !isset($_POST['token']) || !is_string($_POST['token'])) { wp_die('Not allowed.', '', 403); }
    $saved = get_option('hyperprox_login');
    delete_option('hyperprox_login');
    if (!is_array($saved) || empty($saved['hash']) || empty($saved['exp']) || empty($saved['user'])) { wp_die('This sign-in link was already used or has expired.', '', 403); }
    if (time() > (int) $saved['exp']) { wp_die('This sign-in link has expired.', '', 403); }
    if (!hash_equals((string) $saved['hash'], hash('sha256', wp_unslash($_POST['token'])))) { wp_die('This sign-in link is not valid.', '', 403); }
    $user = get_user_by('login', (string) $saved['user']);
    if (!$user || !user_can($user, 'manage_options')) { wp_die('That user is not an administrator.', '', 403); }
    wp_set_current_user($user->ID);
    wp_set_auth_cookie($user->ID, false, is_ssl());
    wp_safe_redirect(admin_url());
    exit;
});
`

export const WORDPRESS_SCRIPT = String.raw`# The installer runs scripts under umask 077; nginx and PHP must be able to read what is written here.
umask 022
# The generated secrets stay in this shell: export -n keeps them out of every child's environment,
# and they reach commands only on standard input.
ADMIN_PW="$WP_ADMIN_PASSWORD"; DB_PW="$WP_DB_PASSWORD"
export -n WP_ADMIN_PASSWORD WP_DB_PASSWORD
if [ -z "$ADMIN_PW" ] || [ -z "$DB_PW" ]; then echo "The installer did not pass the generated passwords." >&2; exit 1; fi
[ -n "$WP_TITLE" ] || WP_TITLE="My WordPress site"
[ -n "$WP_ADMIN_USER" ] || WP_ADMIN_USER=admin
[ -n "$WP_REDIS" ] || WP_REDIS=1

apt-get update -qq
PKGS="nginx mariadb-server php-fpm php-mysql php-curl php-gd php-intl php-mbstring php-xml php-zip php-imagick php-bcmath ca-certificates curl less"
[ "$WP_REDIS" = 1 ] && PKGS="$PKGS redis-server php-redis"
apt-get install -y -qq $PKGS
systemctl enable --now mariadb

PHPV=$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')
cat > /etc/php/$PHPV/fpm/conf.d/90-wordpress.ini <<'INI'
upload_max_filesize = 64M
post_max_size = 64M
memory_limit = 256M
max_execution_time = 120
expose_php = Off
INI
systemctl enable php$PHPV-fpm
systemctl restart php$PHPV-fpm

# WP-CLI, checked against its published SHA-512 before it is installed.
if ! [ -x /usr/local/bin/wp ]; then
  cd /tmp
  curl -fsSLo wp-cli.phar https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
  curl -fsSLo wp-cli.phar.sha512 https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar.sha512
  echo "$(cat wp-cli.phar.sha512)  wp-cli.phar" | sha512sum -c --quiet
  install -m 755 wp-cli.phar /usr/local/bin/wp
  rm -f wp-cli.phar wp-cli.phar.sha512
fi

# The database and its user, local to this container. The password goes in on standard input.
mariadb <<SQL
CREATE DATABASE IF NOT EXISTS wordpress CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'wordpress'@'localhost' IDENTIFIED BY '$DB_PW';
ALTER USER 'wordpress'@'localhost' IDENTIFIED BY '$DB_PW';
GRANT ALL PRIVILEGES ON wordpress.* TO 'wordpress'@'localhost';
FLUSH PRIVILEGES;
SQL

WP_DIR=/var/www/wordpress
mkdir -p $WP_DIR /var/www/.wp-cli
chown www-data:www-data $WP_DIR /var/www/.wp-cli
wpc() { runuser -u www-data -- env HOME=/var/www WP_CLI_CACHE_DIR=/var/www/.wp-cli/cache /usr/local/bin/wp --path=$WP_DIR "$@"; }

# Core from wordpress.org, checked against its published SHA-1 and unpacked with GNU tar (WP-CLI's own
# download cuts file names longer than 100 characters, which current releases have).
if ! [ -f $WP_DIR/wp-load.php ]; then
  curl -fsSLo /tmp/wordpress.tar.gz https://wordpress.org/latest.tar.gz
  curl -fsSLo /tmp/wordpress.tar.gz.sha1 https://wordpress.org/latest.tar.gz.sha1
  echo "$(cat /tmp/wordpress.tar.gz.sha1)  /tmp/wordpress.tar.gz" | sha1sum -c --quiet
  tar -xzf /tmp/wordpress.tar.gz -C $WP_DIR --strip-components=1 --no-same-owner
  chown -R www-data:www-data $WP_DIR
  rm -f /tmp/wordpress.tar.gz /tmp/wordpress.tar.gz.sha1
fi
wpc core verify-checksums --quiet

if [ -f $WP_DIR/wp-config.php ]; then
  # Run again: the newly generated database password replaces the old one, so the vault stays right.
  # WP-CLI cannot prompt for a constant's value, so a short PHP script reads it from standard input.
  cat > /tmp/wp-dbpass.php <<'PHP'
<?php
$pw = trim(fgets(STDIN)); $file = $argv[1];
$c = preg_replace("/define\(\s*'DB_PASSWORD',\s*'[^']*'\s*\);/", "define( 'DB_PASSWORD', '" . $pw . "' );", file_get_contents($file), 1, $n);
if ($n !== 1 || !preg_match('/^[A-Za-z0-9_-]+$/', $pw)) { fwrite(STDERR, "DB_PASSWORD was not updated in wp-config.php\n"); exit(1); }
file_put_contents($file, $c);
PHP
  php /tmp/wp-dbpass.php $WP_DIR/wp-config.php <<<"$DB_PW"
  rm -f /tmp/wp-dbpass.php
else
  # Creating the config generates its salts.
  wpc config create --dbname=wordpress --dbuser=wordpress --dbhost=localhost --dbcharset=utf8mb4 --prompt=dbpass <<<"$DB_PW" >/dev/null
fi
wpc config set DISALLOW_FILE_EDIT true --raw
wpc config set WP_AUTO_UPDATE_CORE minor
wpc config set FS_METHOD direct
# Behind an HTTPS proxy, WordPress must know the visitor used HTTPS, or it loops on redirects.
if ! grep -q HTTP_X_FORWARDED_PROTO $WP_DIR/wp-config.php; then
  cat > /tmp/wp-proxy.php <<'PHP'
if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }
PHP
  awk -v f=/tmp/wp-proxy.php '/stop editing/ && !done { while ((getline l < f) > 0) print l; done = 1 } { print }' $WP_DIR/wp-config.php > /tmp/wp-config.new
  cat /tmp/wp-config.new > $WP_DIR/wp-config.php
  rm -f /tmp/wp-proxy.php /tmp/wp-config.new
fi
chown www-data:www-data $WP_DIR/wp-config.php
chmod 640 $WP_DIR/wp-config.php

URL=$(printf '%s' "$WP_URL" | sed 's:/*$::')
[ -n "$URL" ] || URL="http://$(ip -4 -o addr show eth0 | awk '{ print $4 }' | cut -d/ -f1 | head -n1)"
if wpc core is-installed 2>/dev/null; then
  if wpc user get "$WP_ADMIN_USER" --field=ID >/dev/null 2>&1; then
    wpc user update "$WP_ADMIN_USER" --prompt=user_pass <<<"$ADMIN_PW" >/dev/null
  else
    wpc user create "$WP_ADMIN_USER" "$WP_ADMIN_EMAIL" --role=administrator --prompt=user_pass <<<"$ADMIN_PW" >/dev/null
  fi
else
  wpc core install --url="$URL" --title="$WP_TITLE" --admin_user="$WP_ADMIN_USER" --admin_email="$WP_ADMIN_EMAIL" \
    --skip-email --prompt=admin_password <<<"$ADMIN_PW" >/dev/null
fi
[ -z "$WP_TAGLINE" ] || wpc option update blogdescription "$WP_TAGLINE" >/dev/null
echo "WordPress is installed at $(wpc option get home)."

if [ "$WP_REDIS" = 1 ]; then
  systemctl enable --now redis-server
  systemctl restart php$PHPV-fpm
  wpc plugin is-installed redis-cache || wpc plugin install redis-cache --quiet
  wpc plugin activate redis-cache --quiet
  wpc redis enable --force --quiet
  echo "Redis object cache is on."
fi

# HyperProx's one-time admin sign-in (Sites → Open WordPress admin). It stores nothing until asked.
mkdir -p $WP_DIR/wp-content/mu-plugins
cat > $WP_DIR/wp-content/mu-plugins/hyperprox-login.php <<'PHP'
` + WP_LOGIN_MU_PLUGIN + String.raw`PHP
chown -R www-data:www-data $WP_DIR/wp-content/mu-plugins

` + METRICS_LOG_FORMAT + String.raw`
cat > /etc/nginx/snippets/site-headers.conf <<'NGINX'
` + SECURITY_HEADERS + String.raw`
NGINX
cat > /etc/nginx/sites-available/wordpress <<NGINX
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  root $WP_DIR;
  index index.php;
  client_max_body_size 64m;
  server_tokens off;
  access_log /var/log/nginx/access.log hyperprox_metrics;
  include snippets/site-headers.conf;
` + GZIP + String.raw`

  location / { try_files \$uri \$uri/ /index.php?\$args; }
  location ~ /\.(?!well-known/) { return 404; }
  # XML-RPC is the usual brute-force door; the block editor and the apps use the REST API instead.
  location = /xmlrpc.php { return 403; }
  location ~* ^/wp-content/uploads/.*\.php$ { return 403; }
  location ~ \.php$ {
    include snippets/fastcgi-php.conf;
    fastcgi_pass unix:/run/php/php$PHPV-fpm.sock;
  }
  location ~* \.(?:` + ASSET_EXT + String.raw`)$ {
    try_files \$uri /index.php?\$args;
    add_header Cache-Control "public, max-age=2592000";
    include snippets/site-headers.conf;
    access_log off;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/wordpress /etc/nginx/sites-enabled/wordpress
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload-or-restart nginx
echo "nginx and PHP $PHPV are serving WordPress on port 80."`

/** Said in each web recipe, so nothing implies more than the catalogue does today. */
const NOT_AUTOMATIC = 'Not automatic yet: a backup job, a place under the update policy and a plug-in panel. Set the backup up in Proxmox for now. Monitoring is automatic: the site\'s Metrics tab reads its access log and checks its public address every 5 minutes, with alerts.'

export const CATALOGUE: CatalogueRecipe[] = [
  // ── Reverse proxy ───────────────────────────────────────────────────────
  {
    id: 'nginx-proxy-manager',
    detect: DETECT['nginx-proxy-manager'],
    name: 'Nginx Proxy Manager',
    summary: 'A reverse proxy with a web UI and Let’s Encrypt built in. HyperProx drives it for proxy hosts and certificates.',
    category: 'proxy',
    satisfies: { kind: 'credential', id: 'npm', setting: 'url' },
    port: 81,
    healthPath: '/',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 2, memoryMb: 1024, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstRun: { kind: 'none' },
    wizard: false,
    firstLogin: 'admin@example.com / changeme — it forces a change on first sign-in.',
    notes: [
      'Takes ports 80 and 443 on this container, so give it an address nothing else is publishing from.',
      'Point your router’s port forwards at this container once it is up, or certificates cannot be issued.',
    ],
    install: { kind: 'compose', dir: '/opt/npm', compose: `services:
  app:
    image: jc21/nginx-proxy-manager:latest
    container_name: npm
    restart: unless-stopped
    ports:
      - "80:80"
      - "81:81"
      - "443:443"
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt` },
  },

  // ── Local AI ────────────────────────────────────────────────────────────
  {
    id: 'ollama',
    detect: DETECT['ollama'],
    name: 'Ollama',
    summary: 'Runs open models locally. Gives the deployment wizard a provider that costs nothing and sends nothing off the box.',
    category: 'ai',
    satisfies: { kind: 'credential', id: 'ollama', setting: 'url' },
    port: 11434,
    healthPath: '/api/tags',
    expectStatus: [200],
    needsDocker: false,
    defaults: { cores: 4, memoryMb: 8192, diskGb: 40, swapMb: 1024 },
    minimum: { cores: 2, memoryMb: 4096, diskGb: 20 },
    firstRun: { kind: 'none' },
    wizard: false,
    notes: [
      'No model is pulled here — an 8B model is around 5 GB and which one you want depends on your hardware. Pull one from the AI page once this is up.',
      'CPU only in a plain container. GPU passthrough is a separate piece of work HyperProx does not do for you yet.',
      'Disk fills up fast: each model is gigabytes. 40 GB holds a few.',
    ],
    install: { kind: 'script', script: `apt-get update -qq
apt-get install -y -qq curl ca-certificates
curl -fsSL https://ollama.com/install.sh | sh

# Ollama binds 127.0.0.1 by default, which makes it invisible to anything
# outside its own container - including HyperProx. This is the single most
# common reason a model server "cannot be reached".
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<'CONF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
CONF
systemctl daemon-reload
systemctl enable --now ollama
systemctl restart ollama
sleep 3
echo "Ollama listening on 0.0.0.0:11434. No models pulled yet."` },
  },

  // ── Plex history ────────────────────────────────────────────────────────
  {
    id: 'tautulli',
    detect: DETECT['tautulli'],
    name: 'Tautulli',
    summary: 'Watch history and statistics for Plex. The Plex plug-in reads it for who watched what, and when.',
    category: 'media',
    satisfies: { kind: 'plugin', id: 'plex', setting: 'tautulli_url' },
    port: 8181,
    healthPath: '/auth/login',
    expectStatus: [200],
    needsDocker: true,
    firstRun: { kind: 'none' },
    wizard: false,
    defaults: { cores: 1, memoryMb: 512, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstLogin: 'It asks you to create an account on first open, then for your Plex server.',
    notes: [
      'Point it at your existing Plex server during its own setup — HyperProx does not do that part, because only you know which server and which token.',
      'History starts from the day it is installed. It cannot backfill what Plex has already forgotten.',
    ],
    install: { kind: 'compose', dir: '/opt/tautulli', compose: `services:
  tautulli:
    image: ghcr.io/tautulli/tautulli:latest
    container_name: tautulli
    restart: unless-stopped
    environment:
      - PUID=0
      - PGID=0
      - TZ=Etc/UTC
    ports:
      - "8181:8181"
    volumes:
      - ./config:/config` },
  },

  // ── Backups ─────────────────────────────────────────────────────────────
  {
    id: PBS_RECIPE_ID,
    detect: DETECT[PBS_RECIPE_ID],
    name: 'Proxmox Backup Server',
    summary: 'Deduplicated, verified backups for your guests. Keeps them on a NAS (recommended) or a disk, and connects the PBS plug-in for you.',
    category: 'apps',
    port: 8007,
    // PBS answers only over https with its own certificate; its setup steps check it (pinned), not the generic probe.
    healthPath: '/api2/json/version',
    expectStatus: [401],
    needsDocker: false,
    // The helper-scripts PBS container is unprivileged too; PBS needs nothing a host must grant.
    defaults: { cores: 2, memoryMb: 2048, diskGb: 10, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 1024, diskGb: 8 },
    firstRun: { kind: 'env-admin', user: 'root@pam', passwordEnv: 'PBS_ROOT_PASSWORD' },
    firstLogin: 'Sign in at https://<its address>:8007 as root@pam with the generated password (in the vault). HyperProx makes the tokens it needs itself.',
    notes: [
      NOT_OFFSITE,
      'On a NAS: NFS only. SMB/CIFS is refused, because PBS snapshot names contain ":", which SMB cannot store.',
      'Defaults, editable in PBS later: prune daily (keep last 3, daily 7, weekly 4, monthly 6), GC weekly (Saturday), verify weekly (Sunday).',
    ],
    wizard: false,
    options: PBS_OPTIONS,
    checkOptions: checkPbsOptions,
    setup: 'pbs',
    install: { kind: 'script', script: PBS_SCRIPT },
  },

  // ── Apps the AI wizard can install ──────────────────────────────────────
  {
    id: 'nextcloud',
    detect: DETECT['nextcloud'],
    name: 'Nextcloud',
    summary: 'Files, calendar and contacts you host yourself.',
    category: 'apps',
    port: 80,
    healthPath: '/status.php',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 2, memoryMb: 2048, diskGb: 20, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 1024, diskGb: 10 },
    firstRun: { kind: 'setup-url', path: '/' },
    wizard: true,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  nextcloud:
    image: nextcloud:latest
    restart: unless-stopped
    ports: ["80:80"]
    volumes: ["./data:/var/www/html"]` },
  },
  {
    id: 'jellyfin',
    detect: DETECT['jellyfin'],
    name: 'Jellyfin',
    summary: 'A media server for your own films and shows.',
    category: 'media',
    port: 8096,
    healthPath: '/health',
    expectStatus: [200],
    needsDocker: true,
    wantsGpu: true,
    defaults: { cores: 4, memoryMb: 2048, diskGb: 20, swapMb: 512 },
    minimum: { cores: 2, memoryMb: 1024, diskGb: 10 },
    firstRun: { kind: 'setup-url', path: '/' },
    wizard: true,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports: ["8096:8096"]
    volumes: ["./config:/config", "./media:/media"]` },
  },
  {
    id: 'vaultwarden',
    detect: DETECT['vaultwarden'],
    name: 'Vaultwarden',
    summary: 'A Bitwarden-compatible password server.',
    category: 'apps',
    port: 80,
    healthPath: '/alive',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 1, memoryMb: 512, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    // Sign-ups are off, so a published server is not open to anyone who finds it. The owner signs in to
    // /admin with the generated token (shown once, kept in the vault) and invites users from there.
    firstRun: { kind: 'env-admin', passwordEnv: 'ADMIN_TOKEN', user: '/admin' },
    firstLogin: 'Open /admin and sign in with the admin token shown once after the install (it is kept in the vault). Sign-ups are off: invite each user from there.',
    // Not offered to the wizard until phase 5's first-run lock exists, for the same reason as Grafana:
    // the wizard cannot hand the generated token back to the person who asked. The catalogue page
    // installs it with one.
    wizard: false,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    ports: ["80:80"]
    volumes: ["./data:/data"]
    environment:
      - SIGNUPS_ALLOWED=false
      - ADMIN_TOKEN=\${ADMIN_TOKEN:?the installer sets this}` },
  },
  {
    id: 'gitea',
    detect: DETECT['gitea'],
    name: 'Gitea',
    summary: 'A lightweight Git service with a web UI.',
    category: 'apps',
    port: 3000,
    healthPath: '/',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 2, memoryMb: 1024, diskGb: 12, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstRun: { kind: 'setup-url', path: '/' },
    wizard: true,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  gitea:
    image: gitea/gitea:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./data:/data"]` },
  },
  {
    id: 'uptime-kuma',
    detect: DETECT['uptime-kuma'],
    name: 'Uptime Kuma',
    summary: 'Watches your services and tells you when one goes down.',
    category: 'monitoring',
    port: 3001,
    healthPath: '/',
    expectStatus: [200, 302],
    needsDocker: true,
    defaults: { cores: 1, memoryMb: 512, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstRun: { kind: 'setup-url', path: '/' },
    wizard: true,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:latest
    restart: unless-stopped
    ports: ["3001:3001"]
    volumes: ["./data:/app/data"]` },
  },
  {
    id: 'homepage',
    detect: DETECT['homepage'],
    name: 'Homepage',
    summary: 'A start page that links to everything you run.',
    category: 'apps',
    port: 3000,
    healthPath: '/',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 1, memoryMb: 512, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstRun: { kind: 'none' },
    wizard: true,
    // Current images answer only a Host listed in HOMEPAGE_ALLOWED_HOSTS; anything else, the health
    // check included, gets an error page.
    allowedHostsEnv: 'HOMEPAGE_ALLOWED_HOSTS',
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  homepage:
    image: ghcr.io/gethomepage/homepage:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./config:/app/config"]
    environment:
      - HOMEPAGE_ALLOWED_HOSTS=\${HOMEPAGE_ALLOWED_HOSTS:?the installer sets this}` },
  },
  {
    id: 'grafana',
    detect: DETECT['grafana'],
    name: 'Grafana',
    summary: 'Dashboards for metrics and logs.',
    category: 'monitoring',
    port: 3000,
    healthPath: '/api/health',
    expectStatus: [200],
    needsDocker: true,
    defaults: { cores: 2, memoryMb: 512, diskGb: 8, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 512, diskGb: 8 },
    firstRun: { kind: 'env-admin', passwordEnv: 'GF_SECURITY_ADMIN_PASSWORD', user: 'admin' },
    // Not offered to the wizard until phase 5's first-run lock exists: the wizard cannot hand a
    // generated admin password back to the person who asked, and a service nobody can sign in to
    // safely is not a deployment. The catalogue page installs it with a generated password.
    wizard: false,
    install: { kind: 'compose', dir: '/opt/app', compose: `services:
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: ["./data:/var/lib/grafana"]
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=\${GF_SECURITY_ADMIN_PASSWORD:?the installer sets this}` },
  },

  // ── Web hosting ─────────────────────────────────────────────────────────
  {
    id: 'static-site',
    name: 'Static site',
    summary: 'nginx serving plain HTML, CSS and JavaScript from /var/www/site, such as a project’s marketing site, optionally pulled from a git repository.',
    category: 'web',
    port: 80,
    healthPath: '/',
    expectStatus: [200],
    needsDocker: false,
    defaults: { cores: 1, memoryMb: 512, diskGb: 4, swapMb: 256 },
    minimum: { cores: 1, memoryMb: 256, diskGb: 2 },
    firstRun: { kind: 'none' },
    // No login and no first-run page, so the AI assistant may install and publish it.
    wizard: true,
    firstLogin: 'There is no login. The site is files: put them in /var/www/site, or set a git repository and they are pulled for you.',
    notes: [
      'Pull now: run site-pull in the container (from the Deck). With an interval set, a timer runs it for you.',
      'Only public https:// repositories: there is no deploy key yet, and an address with a password in it is refused.',
      'Static files only. A site that needs a build step must have its built folder committed, then pick that folder.',
      'Assets (CSS, JavaScript, images, fonts) are cached for 30 days; give a changed file a new name or ?v=2. HTML is never cached.',
      'Security headers and gzip are on. HSTS belongs on the HTTPS proxy in front of it, not here.',
      NOT_AUTOMATIC,
    ],
    sizes: { small: { cores: 1, memoryMb: 256, diskGb: 2 }, medium: { cores: 1, memoryMb: 512, diskGb: 4 }, large: { cores: 2, memoryMb: 1024, diskGb: 10 } },
    options: [
      { key: 'SITE_TITLE', label: 'Site title', kind: 'text', default: 'My site', maxLength: 100,
        hint: 'Shown on the starter page when there is no git repository.' },
      { key: 'SITE_REPO', label: 'Git repository (optional)', kind: 'url', maxLength: 300,
        placeholder: 'https://git.example.com/team/site.git',
        hint: 'A public https:// repository. Blank: put the files in /var/www/site yourself.' },
      { key: 'SITE_BRANCH', label: 'Branch', kind: 'gitref', default: 'main', maxLength: 100 },
      { key: 'SITE_DIR', label: 'Folder to serve', kind: 'path', maxLength: 200, placeholder: 'public',
        hint: 'A folder in the repository, such as public or dist. Blank serves the whole repository.' },
      { key: 'SITE_PULL_MINUTES', label: 'Pull every (minutes)', kind: 'number', default: '0', min: 0, max: 1440,
        hint: '0 pulls only at install and when you run site-pull.' },
    ],
    install: { kind: 'script', script: STATIC_SITE_SCRIPT },
  },
  {
    id: 'wordpress',
    detect: DETECT['wordpress'],
    name: 'WordPress',
    summary: 'A website or blog: WordPress on nginx and PHP-FPM, with its own MariaDB database, WP-CLI and an optional Redis object cache.',
    category: 'web',
    port: 80,
    // wp-login.php needs PHP to run and the database to answer: PHP served as source would show
    // "<?php", and a database failure is an error page, not the form.
    healthPath: '/wp-login.php',
    expectStatus: [200],
    healthBody: { contains: ['id="loginform"'], absent: ['<?php', 'Error establishing a database connection'] },
    needsDocker: false,
    defaults: { cores: 2, memoryMb: 2048, diskGb: 10, swapMb: 512 },
    minimum: { cores: 1, memoryMb: 1024, diskGb: 6 },
    firstRun: {
      kind: 'env-admin', passwordEnv: 'WP_ADMIN_PASSWORD', user: 'admin', userOption: 'WP_ADMIN_USER',
      secrets: [{ env: 'WP_DB_PASSWORD', vaultKey: 'db_password' }],
    },
    // Not offered to the AI assistant, for the same reason as Grafana: it cannot hand the generated
    // admin password back to the person who asked.
    wizard: false,
    firstLogin: 'Sign in at /wp-admin as the admin user you chose. Its password is generated, kept in the vault and shown once after the install. The database password is in the same vault item.',
    notes: [
      'Hardened: theme and plug-in file editing is off, minor core releases update themselves, the salts are generated, XML-RPC is blocked and PHP cannot run from uploads.',
      'The database is MariaDB inside the same container, listening only on localhost.',
      'Publishing it: add a proxy host and certificate for it, and set its public address (Settings → General, or here) to the https:// name.',
      'Running the install again sets new passwords for the admin and the database and saves them in the vault.',
      NOT_AUTOMATIC,
    ],
    sizes: { small: { cores: 1, memoryMb: 1024, diskGb: 6 }, medium: { cores: 2, memoryMb: 2048, diskGb: 10 }, large: { cores: 4, memoryMb: 4096, diskGb: 30 } },
    options: [
      { key: 'WP_TITLE', label: 'Site title', kind: 'text', required: true, default: 'My WordPress site', maxLength: 100 },
      { key: 'WP_TAGLINE', label: 'Tagline (optional)', kind: 'text', maxLength: 150, placeholder: 'Just another website' },
      { key: 'WP_ADMIN_USER', label: 'Admin user name', kind: 'username', required: true, maxLength: 60, placeholder: 'yourname',
        hint: 'Lowercase letters, digits, dots, dashes and underscores. Avoid "admin": it is the first name attackers try.' },
      { key: 'WP_ADMIN_EMAIL', label: 'Admin email', kind: 'email', required: true, maxLength: 120 },
      { key: 'WP_URL', label: 'Public address (optional)', kind: 'url', maxLength: 200, placeholder: 'https://blog.example.com',
        hint: 'The https:// name you will publish it on. Blank uses the container’s own address.' },
      { key: 'WP_REDIS', label: 'Redis object cache', kind: 'boolean', default: '1',
        hint: 'Keeps database answers in memory, so pages build faster.' },
    ],
    install: { kind: 'script', script: WORDPRESS_SCRIPT },
  },
]

/** The category names the pages show. */
export const CATEGORY_LABELS: Record<RecipeCategory, string> = {
  proxy: 'Reverse proxy', ai: 'AI', media: 'Media', monitoring: 'Monitoring', apps: 'Apps', web: 'Web hosting',
}

const URL_RE   = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?(?:\/[A-Za-z0-9._~%+\/-]*)?$/
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const USER_RE  = /^[a-z0-9][a-z0-9._-]*$/
const GITREF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/
const PATH_RE  = /^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/
/** Printable characters on one line: no control characters, so nothing can break a line in a script. */
const TEXT_RE  = /^[^\u0000-\u001f\u007f]*$/

/**
 * The recipe's options, checked and filled with defaults. Unknown keys are dropped; a value that does
 * not fit its kind is an error, never quietly changed. The values go to the script as environment
 * variables (quoted), and each kind is narrow enough that a script may use it in a command line.
 */
export function checkOptions(recipe: CatalogueRecipe, raw: unknown): { values: Record<string, string>; errors: string[] } {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const values: Record<string, string> = {}, errors: string[] = []
  for (const o of recipe.options ?? []) {
    const has = Object.prototype.hasOwnProperty.call(given, o.key)
    const rawV = has ? given[o.key] : undefined
    if (rawV !== undefined && rawV !== null && typeof rawV !== 'string' && typeof rawV !== 'number' && typeof rawV !== 'boolean') {
      errors.push(`${o.label}: not a value.`); continue
    }
    let v = rawV === undefined || rawV === null ? (o.default ?? '') : String(rawV).trim()
    if (o.kind === 'boolean') v = ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) ? '1' : ['0', 'false', 'no', 'off', ''].includes(v.toLowerCase()) ? '0' : v
    if (!v) {
      if (o.required) errors.push(`${o.label} is required.`)
      values[o.key] = ''
      continue
    }
    if (o.maxLength && v.length > o.maxLength) { errors.push(`${o.label} is longer than ${o.maxLength} characters.`); continue }
    const bad = (why: string) => errors.push(`${o.label}: ${why}`)
    switch (o.kind) {
      case 'text':     if (!TEXT_RE.test(v)) { bad('one line, with no control characters.'); continue } break
      case 'url':      if (!URL_RE.test(v)) { bad('an https:// address with no user name, password, spaces or query, like https://example.com/path.'); continue } break
      case 'email':    if (!EMAIL_RE.test(v)) { bad('not an email address.'); continue } break
      case 'username': if (!USER_RE.test(v)) { bad('lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit.'); continue } break
      case 'gitref':   if (!GITREF_RE.test(v) || v.includes('..') || v.endsWith('/') || v.endsWith('.lock')) { bad('not a branch or tag name.'); continue } break
      case 'path':     if (!PATH_RE.test(v) || v.split('/').some(s => s === '..' || s === '')) { bad('a folder inside the repository, like public or site/dist, with no "..".'); continue } break
      case 'number': {
        if (!/^\d{1,9}$/.test(v)) { bad('a whole number.'); continue }
        const n = Number(v)
        if ((o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) { bad(`between ${o.min ?? 0} and ${o.max}.`); continue }
        v = String(n); break
      }
      case 'boolean':  if (v !== '1' && v !== '0') { bad('yes or no.'); continue } break
    }
    values[o.key] = v
  }
  if (!errors.length && recipe.checkOptions) errors.push(...recipe.checkOptions(values))
  return { values, errors }
}

/** Why a health answer does not count as serving, or null when it does. */
export function healthProblem(recipe: CatalogueRecipe, status: number | null, body?: string): string | null {
  if (status === null) return 'did not answer'
  if (!recipe.expectStatus.includes(status)) return `answered ${status}, expected ${recipe.expectStatus.join(', ')}`
  const want = recipe.healthBody
  if (!want) return null
  if (typeof body !== 'string') return 'answered, but its page could not be read'
  const missing = want.contains.find(s => !body.includes(s))
  if (missing) return `answered ${status}, but the page does not contain ${missing}`
  const found = (want.absent ?? []).find(s => body.includes(s))
  if (found) return `answered ${status}, but the page contains ${found}`
  return null
}

export function findRecipe(id: string): CatalogueRecipe | undefined {
  return CATALOGUE.find(r => r.id === id)
}

/** Lowercase, trimmed, whitespace to hyphens: how a person or a model writes a service name. */
export function serviceKey(name: string): string {
  return String(name ?? '').toLowerCase().trim().replace(/\s+/g, '-')
}

/**
 * Exact match on normalised id or name; anything looser is a suggestion, never an assumption.
 * Lookups use Array.find, so prototype keys such as "toString" cannot match.
 */
export function matchRecipe(name: string): { recipe?: CatalogueRecipe; suggestions: CatalogueRecipe[] } {
  const key = serviceKey(name)
  if (!key) return { suggestions: [] }
  const recipe = CATALOGUE.find(r => r.id === key || serviceKey(r.name) === key)
  if (recipe) return { recipe, suggestions: [] }
  const suggestions = wizardRecipes().filter(r => r.id.includes(key) || serviceKey(r.name).includes(key))
  return { suggestions }
}

export function wizardRecipes(): CatalogueRecipe[] {
  return CATALOGUE.filter(r => r.wizard)
}
