// =============================================================================
//  HyperProx — QNAP: turning QTS answers into one reading
//
//  Every parser takes the raw text of one answer and returns what it could
//  read; anything missing, empty or malformed becomes null (or an empty list).
//  None of them throws. The same parsers serve both firmware generations:
//
//    legacy      QTS 4.x on ARM and older x86 boxes (storage_v2 = 0): one
//                volume per disk set, no pools, often no fans or CPU sensor.
//    storage-v2  QTS 4.2+ / 5.x Storage & Snapshots (storage_v2 = 1): storage
//                pools under the volumes, CPU temperature, fans.
//
//  The calls (paths) are in client.ts; which of them answered on which firmware
//  is written down in the README's QNAP section.
// =============================================================================

import { child, find, findAll, num, parseXml, textOf, type XNode } from './xml'

export type Health = 'good' | 'warning' | 'bad'

export interface QnapDisk {
  bay:        number
  model:      string | null
  /** As QTS prints it ("2.73 TB"). */
  capacity:   string | null
  sizeBytes:  number | null
  tempC:      number | null
  smart:      Health | null
  /** QTS's own word ("OK", "Warning", "Abnormal"). */
  smartText:  string | null
  lastTest:   { status: string | null; type: string | null; time: string | null }
  /** Shown to operators and above only (routes/qnap.ts). */
  serial:     string | null
  firmware:   string | null
}

export interface QnapVolume {
  id:         string
  name:       string
  /** good, warning (degraded, rebuilding, nearly full is decided by the alerts), bad (failed, not active). */
  health:     Health | null
  status:     string | null
  degraded:   boolean
  totalBytes: number | null
  freeBytes:  number | null
  usedBytes:  number | null
  disks:      number[]
  pool:       string | null
}

export interface QnapPool {
  id:         string
  name:       string
  health:     Health | null
  status:     string | null
  totalBytes: number | null
  usedBytes:  number | null
}

export interface QnapShare { name: string; volume: string | null; usedBytes: number | null }

export interface QnapInterface {
  name:       string
  up:         boolean | null
  speedMbps:  number | null
  ip:         string | null
  mask:       string | null
  mac:        string | null
  mode:       string | null
  rxPackets:  number | null
  txPackets:  number | null
  errors:     number | null
  /** Current throughput, bytes per second, when QTS reports it. */
  rxBps:      number | null
  txBps:      number | null
}

export interface QnapFan { index: number; rpm: number | null; ok: boolean | null }

export interface QnapReading {
  fetchedAt:   string
  generation:  'legacy' | 'storage-v2' | null
  model:       string | null
  hostname:    string | null
  serial:      string | null
  firmware:    { version: string | null; build: string | null; number: string | null }
  update:      { available: boolean | null; version: string | null; checkedAt: string | null }
  uptimeSec:   number | null
  /** QTS's own overall system health word, when it has one. */
  health:      Health | null
  cpuPct:      number | null
  memTotalMB:  number | null
  memFreeMB:   number | null
  sysTempC:    number | null
  cpuTempC:    number | null
  thresholds:  { sysWarnC: number | null; sysErrC: number | null; diskWarnC: number | null; diskErrC: number | null; ssdWarnC: number | null }
  fans:        QnapFan[]
  disks:       QnapDisk[]
  volumes:     QnapVolume[]
  pools:       QnapPool[]
  shares:      QnapShare[]
  interfaces:  QnapInterface[]
  /** Calls that did not answer usefully, by name, so the page can say what is missing and why. */
  missing:     string[]
}

const cut = (s: string | null, n = 120): string | null => (s === null ? null : s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) || null)

// ── login ────────────────────────────────────────────────────────────────────

export interface LoginAnswer {
  passed:    boolean
  sid:       string | null
  /** QTS asks for a second factor: HyperProx cannot answer one, so it does not retry. */
  needs2sv:  boolean
  isAdmin:   boolean | null
}

export function parseLogin(text: unknown): LoginAnswer {
  const x = parseXml(text)
  const sid = textOf(x, 'authSid')
  const passed = textOf(x, 'authPassed') === '1' && !!sid && /^[A-Za-z0-9]{4,64}$/.test(sid)
  const admin = textOf(x, 'isAdmin')
  return {
    passed, sid: passed ? sid : null,
    needs2sv: textOf(x, 'need_2sv') === '1' || textOf(x, 'need2sv') === '1',
    isAdmin: admin === null ? null : admin === '1',
  }
}

/** False when QTS says the session is not (or no longer) signed in. */
export function sessionValid(text: unknown): boolean {
  if (typeof text !== 'string') return false
  if (!/<QDocRoot/i.test(text)) return true   // JSON answers (the share tree) have no authPassed
  const v = textOf(parseXml(text), 'authPassed')
  return v === null || v === '1'
}

// ── system information (manaRequest.cgi?subfunc=sysinfo) ─────────────────────

export interface SysInfo {
  generation: QnapReading['generation']
  model: string | null; hostname: string | null; serial: string | null
  firmware: QnapReading['firmware']
  uptimeSec: number | null; cpuPct: number | null; memTotalMB: number | null; memFreeMB: number | null
  sysTempC: number | null; cpuTempC: number | null
  thresholds: QnapReading['thresholds']
  fans: QnapFan[]
  diskTemps: Map<number, number>
  interfaces: QnapInterface[]
}

function header(x: XNode) {
  const fw = find(x, 'firmware')
  const sv = textOf(find(x, 'model'), 'storage_v2')
  return {
    generation: sv === '1' ? 'storage-v2' as const : sv === '0' ? 'legacy' as const : null,
    model: cut(textOf(find(x, 'model'), 'displayModelName') ?? textOf(find(x, 'model'), 'modelName'), 60),
    firmware: { version: cut(textOf(fw, 'version'), 32), build: cut(textOf(fw, 'build'), 32), number: cut(textOf(fw, 'number'), 32) },
  }
}

export function parseSysinfo(text: unknown): SysInfo {
  const x = parseXml(text)
  const h = header(x)
  const r = find(x, 'root') ?? x
  const t = (n: string) => textOf(r, n)
  const d = num(t('uptime_day')), hr = num(t('uptime_hour')), mi = num(t('uptime_min')), se = num(t('uptime_sec'))
  const uptimeSec = d === null && hr === null && mi === null && se === null ? null : (d ?? 0) * 86400 + (hr ?? 0) * 3600 + (mi ?? 0) * 60 + (se ?? 0)

  const fans: QnapFan[] = []
  const fanCount = Math.min(num(t('sysfan_count')) ?? 0, 16)
  for (let i = 1; i <= fanCount; i++) {
    const rpm = num(t(`sysfan${i}`))
    const stat = t(`sysfan_stat${i}`)
    fans.push({ index: i, rpm, ok: stat === null ? (rpm === null ? null : rpm > 0) : stat === '0' || /ok|normal/i.test(stat) })
  }
  // Some models list CPU fans separately.
  const cpuFans = Math.min(num(t('cpufan_count')) ?? 0, 8)
  for (let i = 1; i <= cpuFans; i++) {
    const rpm = num(t(`cpufan${i}`))
    fans.push({ index: fanCount + i, rpm, ok: rpm === null ? null : rpm > 0 })
  }

  const diskTemps = new Map<number, number>()
  const dn = Math.min(num(t('disk_num')) ?? 0, 64)
  for (let i = 1; i <= dn; i++) { const c = num(t(`tempc${i}`)); if (c !== null && t(`disk_installed${i}`) !== '0') diskTemps.set(i, c) }

  const interfaces: QnapInterface[] = []
  const nics = Math.min(num(t('nic_cnt')) ?? 0, 16)
  for (let i = 1; i <= nics; i++) {
    const st = t(`eth_status${i}`)
    interfaces.push({
      name: cut(t(`dname${i}`) ?? t(`ifname${i}`), 40) ?? `LAN ${i}`,
      up: st === null ? null : st === '1',
      speedMbps: num(t(`eth_max_speed${i}`)),
      ip: cut(t(`eth_ip${i}`), 45), mask: cut(t(`eth_mask${i}`), 45), mac: cut(t(`eth_mac${i}`), 17), mode: cut(t(`eth_usage${i}`), 20),
      rxPackets: num(t(`rx_packet${i}`)), txPackets: num(t(`tx_packet${i}`)), errors: num(t(`err_packet${i}`)),
      rxBps: null, txBps: null,
    })
  }

  return {
    ...h,
    hostname: cut(t('server_name') ?? textOf(x, 'hostname'), 64),
    serial: cut(t('serial_number'), 40),
    uptimeSec,
    cpuPct: num(t('cpu_usage')),
    memTotalMB: num(t('total_memory')),
    memFreeMB: num(t('free_memory')),
    sysTempC: num(t('sys_tempc')),
    cpuTempC: num(t('cpu_tempc')),
    thresholds: {
      sysWarnC: num(t('SysTempWarnT')), sysErrC: num(t('SysTempErrT')),
      diskWarnC: num(t('HDTempWarnT')), diskErrC: num(t('HDTempErrT')), ssdWarnC: num(t('SSDTempWarnT')),
    },
    fans, diskTemps, interfaces,
  }
}

/** sysinfo&sysHealth=yes: "good", "warning", "error". */
export function parseSysHealth(text: unknown): Health | null {
  const s = textOf(find(parseXml(text), 'sysHealth'), 'status')?.toLowerCase()
  if (!s) return null
  if (s === 'good' || s === 'normal' || s === 'ok') return 'good'
  if (s === 'warning' || s === 'warn') return 'warning'
  return 'bad'
}

/** chartReq.cgi?chart_func=QSM40bandwidth: current throughput per interface, in order. */
export function parseBandwidth(text: unknown): Array<{ id: string | null; name: string | null; rx: number | null; tx: number | null }> {
  return findAll(find(parseXml(text), 'bandwidth_info'), 'item').map(it => ({
    id: cut(textOf(it, 'id'), 20), name: cut(textOf(it, 'name'), 40), rx: num(textOf(it, 'rx')), tx: num(textOf(it, 'tx')),
  }))
}

// ── volumes and share sizes (chartReq.cgi?chart_func=disk_usage) ─────────────

const BAD_STATUS = /fail|error|crash|not.?active|unmount|abnormal|inactive|read.?only|removed|missing/i
const WARN_STATUS = /degrad|rebuild|resync|sync|warning|migrat|expand/i

export function statusHealth(status: string | null, code: number | null = null): Health | null {
  if (code !== null && code < 0) return 'bad'
  if (!status) return code === 0 ? 'good' : null
  if (BAD_STATUS.test(status)) return 'bad'
  if (WARN_STATUS.test(status)) return 'warning'
  return 'good'
}

export function parseDiskUsage(text: unknown): { volumes: QnapVolume[]; shares: QnapShare[] } {
  const x = parseXml(text)
  const uses = new Map<string, XNode>()
  for (const u of findAll(x, 'volumeUse')) { const v = textOf(u, 'volumeValue'); if (v) uses.set(v, u) }
  const volumes: QnapVolume[] = []
  for (const v of findAll(find(x, 'volumeList'), 'volume')) {
    const id = textOf(v, 'volumeValue')
    if (!id || !/^[\w.-]{1,32}$/.test(id)) continue
    const status = cut(textOf(v, 'volumeStat') ?? textOf(v, 'volume_status'), 40)
    const code = num(textOf(v, 'volumeStatus'))
    const use = uses.get(id)
    const total = num(textOf(use, 'total_size'))
    const free = num(textOf(use, 'free_size'))
    const health = statusHealth(status, code)
    volumes.push({
      id,
      name: cut(textOf(v, 'volumeLabel') ?? textOf(v, 'volume_label'), 60) ?? `Volume ${id}`,
      health, status, degraded: !!status && WARN_STATUS.test(status) && /degrad|rebuild/i.test(status),
      totalBytes: total, freeBytes: free, usedBytes: total !== null && free !== null ? Math.max(0, total - free) : null,
      disks: (textOf(v, 'volumeDisks') ?? '').split(/[\s,]+/).map(Number).filter(n => Number.isInteger(n) && n > 0 && n < 256),
      pool: cut(textOf(v, 'poolID') ?? textOf(v, 'pool_id'), 20),
    })
  }
  const shares: QnapShare[] = []
  for (const u of findAll(x, 'volumeUse')) {
    const vol = textOf(u, 'volumeValue')
    for (const f of findAll(u, 'folder_element')) {
      const name = cut(textOf(f, 'sharename'), 80)
      if (!name || textOf(f, 'type') === 'system') continue
      shares.push({ name, volume: vol, usedBytes: num(textOf(f, 'used_size')) })
    }
  }
  return { volumes, shares }
}

/** Storage pools (storage-v2 firmware, disk_manage.cgi?store=poolInfo). Field names vary; read defensively. */
export function parsePools(text: unknown): QnapPool[] {
  const x = parseXml(text)
  const out: QnapPool[] = []
  for (const p of [...findAll(x, 'Pool_Index'), ...findAll(x, 'pool')]) {
    const id = textOf(p, 'poolID') ?? textOf(p, 'pool_id') ?? textOf(p, 'poolId')
    if (!id || !/^[\w.-]{1,32}$/.test(id) || out.some(o => o.id === id)) continue
    const status = cut(textOf(p, 'pool_status') ?? textOf(p, 'poolStatus') ?? textOf(p, 'status'), 40)
    const code = num(textOf(p, 'pool_status_code'))
    const total = num(textOf(p, 'capacity_bytes') ?? textOf(p, 'pool_size') ?? textOf(p, 'total_size'))
    const used = num(textOf(p, 'allocated_bytes') ?? textOf(p, 'used_size'))
    out.push({
      id, name: cut(textOf(p, 'pool_name') ?? textOf(p, 'poolName'), 60) ?? `Storage pool ${id}`,
      health: statusHealth(status && /^-?\d+$/.test(status) ? null : status, code ?? (status && /^-?\d+$/.test(status) ? Number(status) : null)),
      status, totalBytes: total, usedBytes: used,
    })
  }
  return out
}

// ── disks (qsmart.cgi?func=all_hd_data) ──────────────────────────────────────

export function smartHealth(word: string | null): Health | null {
  if (!word || /^-+$/.test(word)) return null
  if (/^(ok|good|normal)$/i.test(word.trim())) return 'good'
  if (/warn/i.test(word)) return 'warning'
  return 'bad'
}

const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 }
/** "2.73 TB" to bytes (QTS prints binary units with decimal names). */
export function sizeBytes(s: string | null): number | null {
  const m = /^\s*([\d.]+)\s*([KMGTP]?B)\s*$/i.exec(s ?? '')
  if (!m) return null
  const n = Number(m[1]) * (UNITS[m[2].toUpperCase()] ?? NaN)
  return Number.isFinite(n) ? Math.round(n) : null
}

export function parseSmart(text: unknown): { disks: QnapDisk[]; diskWarnC: number | null; diskErrC: number | null } {
  const x = parseXml(text)
  const disks: QnapDisk[] = []
  for (const e of findAll(find(x, 'Disk_Info'), 'entry')) {
    const bay = num(textOf(e, 'HDNo'))
    if (bay === null || !Number.isInteger(bay) || bay < 1 || bay > 255 || disks.some(d => d.bay === bay)) continue
    const word = cut(textOf(e, 'Health'), 30)
    // io_health is QTS's read of disk errors; a bad one is bad whatever SMART says.
    const io = smartHealth(cut(textOf(e, 'io_health'), 30))
    let smart = smartHealth(word)
    if (io === 'bad' || (io === 'warning' && smart === 'good')) smart = io
    const cap = cut(textOf(e, 'Capacity'), 20)
    const temp = child(e, 'Temperature')
    disks.push({
      bay,
      model: cut(textOf(e, 'Model') ?? textOf(e, 'Vendor')?.replace(/\s+/g, ' ') ?? null, 60),
      capacity: cap, sizeBytes: sizeBytes(cap),
      tempC: num(textOf(temp, 'oC')),
      smart, smartText: word,
      lastTest: { status: cut(textOf(e, 'LastTestSts'), 60), type: cut(textOf(e, 'LastTestType'), 30), time: cut(textOf(e, 'LastTestTime'), 40) },
      serial: cut(textOf(e, 'Serial'), 40),
      firmware: cut(textOf(e, 'FirmVersion'), 20),
    })
  }
  return { disks: disks.sort((a, b) => a.bay - b.bay), diskWarnC: num(textOf(x, 'HDTempWarnT')), diskErrC: num(textOf(x, 'HDTempErrT')) }
}

// ── firmware updates (sysRequest.cgi?subfunc=firm_update) ────────────────────

export function parseFirmwareUpdate(text: unknown): QnapReading['update'] & { uptimeSec: number | null } {
  const x = parseXml(text)
  const v = cut(textOf(x, 'newVersion'), 60)
  return {
    available: v === null ? null : !/^(none|null|0|-+)$/i.test(v),
    version: v && !/^(none|null|0|-+)$/i.test(v) ? v : null,
    checkedAt: cut(textOf(x, 'updateCheckTime'), 30),
    uptimeSec: num(textOf(x, 'uptimeSec')),
  }
}

// ── shares (filemanager/utilRequest.cgi?func=get_tree&node=share_root) ───────

export function parseShareTree(text: unknown): string[] {
  let v: unknown
  try { v = JSON.parse(typeof text === 'string' ? text : '') } catch { return [] }
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const e of v.slice(0, 500)) {
    const name = cut(typeof (e as any)?.text === 'string' ? (e as any).text : null, 80)
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

// ── the whole reading ────────────────────────────────────────────────────────

export interface RawAnswers {
  sysinfo?:   string | null
  health?:    string | null
  usage?:     string | null
  smart?:     string | null
  firmware?:  string | null
  bandwidth?: string | null
  shares?:    string | null
  pools?:     string | null
}

/** One reading from the answers that came back. A call that failed is null here and named in `missing`. */
export function buildReading(raw: RawAnswers, now = new Date()): QnapReading {
  const missing: string[] = []
  const has = (k: keyof RawAnswers, ok: (t: string) => boolean) => {
    const t = raw[k]
    if (typeof t === 'string' && ok(t)) return t
    missing.push(k)
    return null
  }
  const xmlOk = (t: string) => /<QDocRoot/i.test(t) && sessionValid(t)
  const sys = parseSysinfo(has('sysinfo', xmlOk))
  const smartT = has('smart', t => xmlOk(t) && /<Disk_Info/i.test(t))
  const smart = parseSmart(smartT)
  const usage = parseDiskUsage(has('usage', t => xmlOk(t) && /<volumeList/i.test(t)))
  const fw = parseFirmwareUpdate(has('firmware', t => xmlOk(t) && /newVersion|liveUpdate/i.test(t)))
  const health = parseSysHealth(has('health', t => xmlOk(t) && /sysHealth/i.test(t)))
  const bw = parseBandwidth(raw.bandwidth ?? null)
  const tree = parseShareTree(has('shares', t => t.trim().startsWith('[')))
  const pools = sys.generation === 'storage-v2' ? parsePools(raw.pools ?? null) : []

  // Disk temperatures: SMART's own reading first, sysinfo's per-bay reading when SMART has none.
  const disks = smart.disks.map(d => ({ ...d, tempC: d.tempC ?? sys.diskTemps.get(d.bay) ?? null }))
  for (const [bay, t] of sys.diskTemps) {
    if (!disks.some(d => d.bay === bay)) disks.push({ bay, model: null, capacity: null, sizeBytes: null, tempC: t, smart: null, smartText: null, lastTest: { status: null, type: null, time: null }, serial: null, firmware: null })
  }
  disks.sort((a, b) => a.bay - b.bay)

  const interfaces = sys.interfaces.map((n, i) => {
    const b = bw[i]
    return { ...n, name: b?.name ?? n.name, rxBps: b?.rx ?? null, txBps: b?.tx ?? null }
  })

  // Shares: every name the file tree lists, with the size QTS counted for it; then any it sized but did not list.
  const sized = new Map(usage.shares.map(s => [s.name, s]))
  const shares: QnapShare[] = tree.map(name => sized.get(name) ?? { name, volume: null, usedBytes: null })
  for (const s of usage.shares) if (!tree.includes(s.name)) shares.push(s)

  return {
    fetchedAt: now.toISOString(),
    generation: sys.generation,
    model: sys.model, hostname: sys.hostname, serial: sys.serial,
    firmware: sys.firmware,
    update: { available: fw.available, version: fw.version, checkedAt: fw.checkedAt },
    uptimeSec: sys.uptimeSec ?? fw.uptimeSec,
    health,
    cpuPct: sys.cpuPct, memTotalMB: sys.memTotalMB, memFreeMB: sys.memFreeMB,
    sysTempC: sys.sysTempC, cpuTempC: sys.cpuTempC,
    thresholds: {
      ...sys.thresholds,
      // all_hd_data carries the thresholds Storage Manager uses for its own warnings; prefer them.
      diskWarnC: smart.diskWarnC ?? sys.thresholds.diskWarnC, diskErrC: smart.diskErrC ?? sys.thresholds.diskErrC,
    },
    fans: sys.fans, disks, volumes: usage.volumes, pools, shares, interfaces, missing,
  }
}
