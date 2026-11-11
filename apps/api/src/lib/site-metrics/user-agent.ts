// =============================================================================
//  HyperProx — site metrics: what a User-Agent says, roughly
//
//  A small built-in reader, not a full UA database: the browser family, the
//  operating system and the kind of device, which is all the Metrics page
//  shows. Order matters, because most browsers claim to be several others
//  ("Chrome" says Safari, "Edge" says Chrome).
//
//  Bots are known by name (crawlers, monitors, HTTP libraries, scanners) and
//  by behaviour: no User-Agent at all, one too short to be a browser, or a
//  request for a path that only a vulnerability scanner asks for.
// =============================================================================

export type Device = 'desktop' | 'mobile' | 'tablet' | 'bot'

export interface UaClass { browser: string; os: string; device: Device; bot: boolean }

const BOT_NAMES = new RegExp([
  'bot\\b', 'bot/', 'crawler', 'crawl', 'spider', 'slurp', 'archiver', 'scan', 'scrap', 'monitor', 'uptime', 'pingdom',
  'statuscake', 'checker', 'validator', 'preview', 'fetcher', 'feed', 'rss', 'headless', 'phantomjs', 'puppeteer', 'playwright',
  'selenium', 'lighthouse', 'pagespeed', 'curl/', 'wget/', 'httpie', 'python-requests', 'python-urllib', 'aiohttp', 'httpx',
  'go-http-client', 'java/', 'okhttp', 'apache-httpclient', 'libwww-perl', 'node-fetch', 'axios/', 'undici', 'ruby',
  'php/', 'guzzle', 'zgrab', 'masscan', 'nmap', 'nuclei', 'nikto', 'sqlmap', 'censys', 'shodan', 'leakix', 'l9scan',
  'expanse', 'internet-measurement', 'facebookexternalhit', 'whatsapp', 'telegram', 'discord', 'slack', 'embedly',
  'gptbot', 'chatgpt', 'oai-searchbot', 'claudebot', 'anthropic', 'perplexity', 'bytespider', 'ccbot', 'amazonbot',
  'applebot', 'yandex', 'baidu', 'duckduck', 'bingpreview', 'semrush', 'ahrefs', 'mj12', 'dotbot', 'petalbot',
  'dataforseo', 'certificate monitor', 'cert monitor', 'netcraft', 'wordpress/', 'wp-cli',
].join('|'), 'i')

/** Paths nobody but a scanner asks a website for. */
const PROBE_PATHS = new RegExp([
  '^/\\.(?!well-known/)', '/\\.git(/|$)', '/\\.env', '/\\.aws', '/\\.ssh', '/\\.vscode', '/\\.DS_Store',
  '^/(cgi-bin|phpmyadmin|pma|myadmin|adminer|actuator|server-status|server-info|telescope|debug|console|solr|jenkins|manager/html|boaform|HNAP1|owa|ecp|autodiscover|vendor/phpunit|_ignition|\\.well-known/security\\.txt$)',
  '(^|/)(wp-config\\.php|config\\.json|info\\.php|phpinfo\\.php|shell\\.php|eval-stdin\\.php|setup\\.php|install\\.php)$',
  '/(trace\\.axd|elmah\\.axd|web\\.config|login\\.action|META-INF/)', '/@vite/', '/v2/_catalog$', '___proxy_subdomain',
].join('|'), 'i')

/** True for a request path only a vulnerability scanner asks for. */
export function isProbePath(path: string): boolean {
  return PROBE_PATHS.test(path)
}

export function isBotUa(ua: string): boolean {
  const u = ua.trim()
  if (!u || u === '-') return true
  if (BOT_NAMES.test(u)) return true
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
