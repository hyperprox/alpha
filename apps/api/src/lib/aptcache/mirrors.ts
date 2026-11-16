// =============================================================================
//  HyperProx — the package cache: which archives it serves
//
//  Copied from apt-cacher-ng 3.7.5-1's own mirror lists (deb_mirrors.gz and
//  ubuntu_mirrors, the Debian package the recipe pins), so a guest is pointed at
//  the cache only for a host and path the cache really serves with ForceManaged
//  on. Everything else goes direct. Update these with the pinned version.
// =============================================================================

/** Debian mirrors apt-cacher-ng serves under /debian/ (its debrep remap). */
export const DEBIAN_HOSTS: readonly string[] = [
  'cdn-fastly.deb.debian.org', 'deb.debian.org', 'ftp1.de.debian.org', 'ftp2.ca.debian.org', 'ftp2.cn.debian.org',
  'ftp2.de.debian.org', 'ftp2.fr.debian.org', 'ftp2.jp.debian.org', 'ftp2.us.debian.org', 'ftp3.ca.debian.org',
  'ftp3.us.debian.org', 'ftp4.ca.debian.org', 'ftp.am.debian.org', 'ftp.at.debian.org', 'ftp.au.debian.org',
  'ftp.be.debian.org', 'ftp.bg.debian.org', 'ftp.br.debian.org', 'ftp.by.debian.org', 'ftp.ca.debian.org',
  'ftp.ch.debian.org', 'ftp.cn.debian.org', 'ftp.cz.debian.org', 'ftp.debian.org', 'ftp.de.debian.org',
  'ftp.dk.debian.org', 'ftp.ee.debian.org', 'ftp.es.debian.org', 'ftp.fi.debian.org', 'ftp.fr.debian.org',
  'ftp.gr.debian.org', 'ftp.hk.debian.org', 'ftp.hr.debian.org', 'ftp.hu.debian.org', 'ftp.is.debian.org',
  'ftp.it.debian.org', 'ftp.kr.debian.org', 'ftp.lt.debian.org', 'ftp.md.debian.org', 'ftp.mx.debian.org',
  'ftp.nc.debian.org', 'ftp.nl.debian.org', 'ftp.no.debian.org', 'ftp.nz.debian.org', 'ftp.pl.debian.org',
  'ftp.pt.debian.org', 'ftp.ro.debian.org', 'ftp.ru.debian.org', 'ftp.se.debian.org', 'ftp.sg.debian.org',
  'ftp.si.debian.org', 'ftp.sk.debian.org', 'ftp.sv.debian.org', 'ftp.tw.debian.org', 'ftp.uk.debian.org',
  'ftp.us.debian.org',
]

/** Ubuntu country mirrors (<code>.archive.ubuntu.com) apt-cacher-ng serves under /ubuntu/ (its uburep remap). */
export const UBUNTU_CODES: readonly string[] = [
  'ac', 'ad', 'ae', 'af', 'ag', 'ai', 'al', 'am', 'an', 'ao', 'aq', 'ar', 'as', 'at', 'au', 'aw', 'ax', 'az', 'aze',
  'ba', 'bb', 'bd', 'be', 'bf', 'bg', 'bh', 'bi', 'bj', 'bl', 'bm', 'bn', 'bo', 'bq', 'br', 'bs', 'bt', 'bv', 'bw',
  'by', 'bz', 'ca', 'cc', 'cd', 'cf', 'cg', 'ch', 'ci', 'ck', 'cl', 'cm', 'cn', 'co', 'cr', 'cu', 'cv', 'cw', 'cx',
  'cy', 'cz', 'de', 'dj', 'dk', 'dm', 'do', 'dz', 'ec', 'ee', 'eg', 'eh', 'er', 'es', 'et', 'eu', 'fi', 'fj', 'fk',
  'fm', 'fo', 'fr', 'ga', 'gb', 'gd', 'ge', 'gf', 'gg', 'gh', 'gi', 'gl', 'gm', 'gn', 'gp', 'gq', 'gr', 'gs', 'gt',
  'gu', 'gw', 'gy', 'hk', 'hm', 'hn', 'hr', 'ht', 'hu', 'id', 'ie', 'il', 'im', 'in', 'io', 'iq', 'ir', 'is', 'it',
  'je', 'jm', 'jo', 'jp', 'ke', 'kg', 'kh', 'ki', 'km', 'kn', 'kp', 'kr', 'ky', 'kz', 'la', 'lb', 'lc', 'li', 'lk',
  'lr', 'ls', 'lt', 'lu', 'lv', 'ly', 'ma', 'mc', 'md', 'me', 'mf', 'mg', 'mh', 'mk', 'ml', 'mm', 'mn', 'mo', 'mp',
  'mq', 'mr', 'ms', 'mt', 'mv', 'mw', 'mx', 'my', 'mz', 'na', 'nc', 'ne', 'nf', 'ng', 'ni', 'nl', 'no', 'np', 'nr',
  'nu', 'nz', 'om', 'pa', 'pe', 'pf', 'pg', 'ph', 'pk', 'pl', 'pm', 'pn', 'pr', 'ps', 'pt', 'pw', 'py', 'qa', 're',
  'ro', 'rs', 'ru', 'rw', 'sa', 'sb', 'sc', 'sd', 'se', 'sg', 'sh', 'si', 'sj', 'sk', 'sl', 'sm', 'sn', 'so', 'sr',
  'ss', 'st', 'su', 'sv', 'sx', 'sy', 'sz', 'tc', 'td', 'tf', 'tg', 'th', 'tj', 'tk', 'tl', 'tm', 'tn', 'to', 'tp',
  'tr', 'tt', 'tv', 'tw', 'tz', 'ua', 'ug', 'uk', 'um', 'us', 'uy', 'uz', 'va', 'vc', 've', 'vg', 'vi', 'vn', 'vu',
  'wf', 'ws', 'ye', 'yt', 'za', 'zm', 'zw',
]

/**
 * Hosts on which the cache serves more than /debian/: the security archive (secdeb). HyperProx also remaps their debug
 * and ports archives, because apt decides once per host, so every path a guest is likely to use there must work.
 */
export const DEBIAN_FULL_HOSTS: readonly string[] = ['deb.debian.org', 'cdn-fastly.deb.debian.org']
