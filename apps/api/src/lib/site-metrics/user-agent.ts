// =============================================================================
//  HyperProx — site metrics: what a User-Agent says, roughly
//
//  A small built-in reader, not a full UA database: the browser family, the
//  operating system and the kind of device, which is all the Metrics page
//  shows. Order matters, because most browsers claim to be several others
//  ("Chrome" says Safari, "Edge" says Chrome).
//
//  Bots are known by name (crawlers, monitors, HTTP libraries, scanners), by
//  a User-Agent that no real browser sends (missing, too short, years out of
//  date, or a fake that scanners copy from each other), and by behaviour: a
//  request for a path that only a vulnerability scanner asks for.
//  HyperProx's own requests (User-Agent "HyperProx-…") are told apart first
//  and never counted as anyone's.
// =============================================================================

export type Device = 'desktop' | 'mobile' | 'tablet' | 'bot'

export interface UaClass { browser: string; os: string; device: Device; bot: boolean }

const BOT_NAMES = new RegExp([
  'bot\\b', 'bot/', 'crawler', 'crawl', 'spider', 'slurp', 'archiver', 'scan', 'scrap', 'monitor', 'uptime', 'pingdom',
  'statuscake', 'checker', 'validator', 'preview', 'fetcher', 'feed', 'rss', 'headless', 'phantomjs', 'puppeteer', 'playwright',
  'selenium', 'lighthouse', 'pagespeed', 'curl/', 'libcurl', 'wget/', 'httpie', 'python-requests', 'python-urllib', 'python/', 'aiohttp', 'httpx',
  'go-http-client', 'go-resty', 'java/', 'okhttp', 'apache-httpclient', 'libwww-perl', 'node-fetch', '^node$', '^node/', 'deno/', '^bun/', 'axios/',
  'undici', 'got \\(', 'reqwest', 'ruby', 'php/', 'guzzle', 'zgrab', 'masscan', 'nmap', 'nuclei', 'nikto', 'sqlmap', 'censys', 'shodan',
  'leakix', 'l9scan', 'l9explore', 'expanse', 'internet-measurement', 'facebookexternalhit', 'whatsapp', 'telegram', 'discord', 'slack',
  'embedly', 'gptbot', 'chatgpt', 'oai-searchbot', 'claudebot', 'anthropic', 'perplexity', 'bytespider', 'ccbot', 'amazonbot',
  'applebot', 'yandex', 'baidu', 'duckduck', 'bingpreview', 'semrush', 'ahrefs', 'mj12', 'dotbot', 'petalbot',
  'dataforseo', 'certificate monitor', 'cert monitor', 'certstream', 'netcraft', 'agenttrust', 'agentdata', 'wordpress/', 'wp-cli',
].join('|'), 'i')

/**
 * User-Agents real browsers stopped sending years ago, that scanners keep copying from each other. Not here on
 * purpose: "Android 10; K", which looks fake but is what every current Chrome on Android sends since Google froze
 * that part of the User-Agent.
 */
const SPOOFED = [
  /iPhone OS 13_2_3 like Mac OS X.*Version\/13\.0\.3/,   // the iPhone UA in many scanners' defaults
  /CPU (iPhone )?OS [1-9]_\d+(_\d+)? like Mac OS X/,       // iOS 9 or older
  /Windows NT 11\.0/,                                      // Windows 11 says "Windows NT 10.0"
  /Windows NT [4-5]\.\d/,                                  // Windows 2000 / XP
  /^Mozilla\/5\.0\d/,                                      // "Mozilla/5.062334851 Mozilla/5.0 (…"
  /Mozilla\/5\.0.*Mozilla\/5\.0/,                          // two User-Agents glued together
  /^https?:\/\//i,                                         // a URL in place of a User-Agent
]

/** True for a browser version or a User-Agent shape that no real browser sends any more. */
export function isSpoofedUa(ua: string): boolean {
  const u = ua.trim()
  if (SPOOFED.some(r => r.test(u))) return true
  const chrome = /(?:Chrome|CriOS)\/(\d+)\./.exec(u)
  if (chrome && Number(chrome[1]) < 70) return true      // 2018
  const firefox = /Firefox\/(\d+)\./.exec(u)
  if (firefox && Number(firefox[1]) < 60) return true    // 2018
  // A desktop WebKit User-Agent that stops before naming a browser: cut short by a script, not sent by one.
  if (/AppleWebKit\//.test(u) && /(Windows NT|X11|Macintosh)/.test(u) && !/(Chrome|Chromium|Safari|Firefox|Edg|OPR|Version)\//.test(u)) return true
  return false
}

/** HyperProx's own requests: catalogue detection, site checks, probes. Never counted as a visitor or a bot. */
export function isOwnUa(ua: string): boolean {
  return /^HyperProx(?:[-/ ]|$)/i.test(ua.trim())
}

export type ProbeKind = 'secrets' | 'admin' | 'php' | 'api' | 'other'
export const PROBE_KINDS: ProbeKind[] = ['secrets', 'admin', 'php', 'api', 'other']

const SECRETS = new RegExp([
  '(^|/)\\.(?!well-known(/|$))[^/]',                      // any dotfile or dot-directory: .env, .git, .aws, .DS_Store, .vscode …
  '(^|/)(wp-config\\.php[^/]*|config\\.(ya?ml|php)|web\\.config|sftp(-config)?\\.json|credentials(\\.json)?|secrets?\\.(json|ya?ml)|id_rsa|docker-compose\\.ya?ml)$',
  '(^|/)(backup|backups|db|dump|database|site|www)\\.(sql|zip|tar|tar\\.gz|tgz|bak|7z|rar)$', '\\.(sql|bak|old|orig|swp)$',
  '^/@vite/env',
].join('|'), 'i')

/** Names a site may really serve (an app's settings for the browser), so they are probes only when refused. */
const MAYBE_SECRETS = /(^|\/)(config|env|settings|appsettings)\.(json|js)$/i

/** Admin panels and consoles that scanners look for on any site. */
const ADMIN = new RegExp('^/(' + [
  'phpmyadmin', 'pma', 'myadmin', 'mysqladmin', 'adminer', 'actuator', 'server-status', 'server-info', 'telescope', 'debug', 'console',
  'solr', 'jenkins', 'manager/html', 'boaform', 'HNAP1', 'owa', 'ecp', 'autodiscover', 'login\\.action', '___proxy_subdomain', 'cgi-bin',
  'cpanel', 'whm', 'webmail', 'remote/login', 'geoserver', 'jmx-console', 'hudson', 'druid', 'nacos',
].join('|') + ')([/_.?]|$)', 'i')

/** WordPress's admin and API, which only a WordPress site has. */
const WP = /^\/(wp-admin|wp-login\.php|wp-includes|wp-content|wp-json|xmlrpc\.php|wp-cron\.php|wordpress)([/?]|$)/i
/** Admin and login pages a static site does not have. */
const STATIC_ADMIN = /^\/(admin|administrator|login|user\/login|auth\/login|signin|dashboard|panel)(\/|$)/i
/** PHP files any scanner tries; on a static site every .php is one. */
const PHP_ALWAYS = /(^|\/)(info|phpinfo|php_info|test|shell|eval-stdin|setup|install|i|x|cmd|upl|up|wso|alfa|c99|r57)\.php$|^\/(vendor\/phpunit|_ignition)(\/|$)/i
/** An API path on a site with no API. */
const STATIC_API = /^\/(api|graphql|gql|jsonrpc|soap)(\/|$)/i
const OTHER = /\/(trace\.axd|elmah\.axd|META-INF\/)|\/v2\/_catalog$|^\/\.well-known\/security\.txt$/i

/**
 * What kind of scanner probe a path is, or null for an ordinary request. `kind` is the site's: on a static site
 * every .php, every /api/ and WordPress's own paths are probes; on WordPress and other apps they are not.
 * With `status`, a guess that depends on what the site is (a static site has no /api/ or /admin, another app may be
 * WordPress after all) or a name a site may really serve (config.json) is a probe only when the site did not
 * answer it: a 2xx or 304 means the site has that page.
 */
export function probeKind(path: string, kind: 'static' | 'wordpress' | 'other' = 'other', status?: number): ProbeKind | null {
  if (!path) return null
  if (/^\/\.well-known\/(?!security\.txt$)/i.test(path)) return null
  if (SECRETS.test(path)) return 'secrets'
  if (PHP_ALWAYS.test(path)) return 'php'
  if (ADMIN.test(path)) return 'admin'
  if (OTHER.test(path)) return 'other'
  const served = status !== undefined && ((status >= 200 && status < 300) || status === 304)
  if (MAYBE_SECRETS.test(path) && !served) return 'secrets'
  if (kind === 'static') {
    // A static site has no PHP and no WordPress: asking is a probe, whatever a catch-all page answered.
    if (WP.test(path)) return 'admin'
    if (/\.php(\/|$)/i.test(path)) return 'php'
    if (served) return null
    if (STATIC_ADMIN.test(path)) return 'admin'
    if (STATIC_API.test(path)) return 'api'
  } else if (kind === 'other' && WP.test(path) && !served) return 'admin'
  return null
}

/** True for a request path only a vulnerability scanner asks for, on any kind of site. */
export function isProbePath(path: string): boolean {
  const k = probeKind(path, 'other')
  // WordPress's own paths are scanner bait on other sites, but not on every site: leave them to probeKind.
  return k !== null && !(k === 'admin' && WP.test(path))
}

export function isBotUa(ua: string): boolean {
  const u = ua.trim()
  if (!u || u === '-') return true
  if (BOT_NAMES.test(u)) return true
  if (isSpoofedUa(u)) return true
  // "Mozilla/5.0" and nothing else, or similar: no real browser sends so little.
  if (u.length < 25 && !/(Firefox|Chrome|Safari|Edg|OPR)\//.test(u)) return true
  return false
}

function browserOf(u: string): string {
  if (/Edg(e|A|iOS)?\//.test(u)) return 'Edge'
  if (/OPR\/|Opera/.test(u)) return 'Opera'
  if (/SamsungBrowser\//.test(u)) return 'Samsung Internet'
  if (/Vivaldi\//.test(u)) return 'Vivaldi'
  if (/YaBrowser\//.test(u)) return 'Yandex'
  if (/Firefox\/|FxiOS\//.test(u)) return 'Firefox'
  if (/Chrome\/|CriOS\/|Chromium\//.test(u)) return 'Chrome'
  if (/Safari\//.test(u) && /Version\//.test(u)) return 'Safari'
  if (/AppleWebKit\//.test(u) && /(iPhone|iPad|Macintosh)/.test(u)) return 'Safari'
  return 'Other'
}

function osOf(u: string): string {
  if (/Windows Phone/.test(u)) return 'Windows Phone'
  if (/Windows NT|Win64|WOW64|Windows/.test(u)) return 'Windows'
  if (/iPhone|iPod/.test(u)) return 'iOS'
  if (/iPad/.test(u)) return 'iPadOS'
  if (/Android/.test(u)) return 'Android'
  if (/CrOS/.test(u)) return 'ChromeOS'
  if (/Mac OS X|Macintosh/.test(u)) return 'macOS'
  if (/Linux|X11|Ubuntu|Fedora|Debian/.test(u)) return 'Linux'
  return 'Other'
}

function deviceOf(u: string): Device {
  if (/iPad|Tablet|PlayBook|Silk\/|Kindle/.test(u) || (/Android/.test(u) && !/Mobile/.test(u))) return 'tablet'
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|Opera Mini/.test(u)) return 'mobile'
  return 'desktop'
}

export function classifyUa(ua: string): UaClass {
  if (isBotUa(ua)) return { browser: 'Bot', os: 'Bot', device: 'bot', bot: true }
  return { browser: browserOf(ua), os: osOf(ua), device: deviceOf(ua), bot: false }
}
