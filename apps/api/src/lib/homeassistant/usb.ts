// =============================================================================
//  HyperProx — Home Assistant: the USB devices on a node, for the wizard's "pass in a stick" question
//
//  A read-only look over the node's login at what is plugged in, from the kernel's own list (so it works without lsusb). A
//  device is offered only when passing it to a virtual machine cannot take something away from the node: HyperProx reads each
//  interface's class and the driver bound to it, and whether a block device or a network interface sits behind the device.
//  It refuses, with the reason, a hub, mass storage (class 08, usb-storage, uas), a wireless controller (e0), a network adapter
//  (a network driver, or a network interface behind it) and anything with a disk behind it. A serial stick (Zigbee, Z-Wave, class
//  02 and 0a bound to cdc_acm, or a vendor-specific serial chip) is the thing this is for and is allowed.
//
//  vendor:product matches every identical device, so when two identical devices are plugged in each is named by its bus-port
//  (1-2.3) instead, and a vendor:product that would match both is refused. The same check runs again at install time.
// =============================================================================

export const HAVM_USB_SCRIPT = `for d in /sys/bus/usb/devices/*; do
  n=$(basename "$d")
  case "$n" in *:*|usb*) continue ;; esac
  [ -f "$d/idVendor" ] || continue
  cls="$(cat "$d/bDeviceClass" 2>/dev/null || echo 00)"; drv=""
  for i in "$d"/"$n":*; do
    [ -d "$i" ] || continue
    cls="$cls,$(cat "$i/bInterfaceClass" 2>/dev/null || echo 00)"
    drv="$drv,$(basename "$(readlink "$i/driver" 2>/dev/null)" 2>/dev/null)"
  done
  blk=0; for b in /sys/block/*; do [ -e "$b" ] && readlink -f "$b" | grep -q "/$n/" && blk=1; done
  net=0; for b in /sys/class/net/*; do [ -e "$b" ] && readlink -f "$b" | grep -q "/$n/" && net=1; done
  printf '@@usb %s:%s|%s|%s|%s|%s|%s|%s|%s\\n' "$(cat "$d/idVendor")" "$(cat "$d/idProduct")" "$(cat "$d/manufacturer" 2>/dev/null | tr -d '|\\n')" "$(cat "$d/product" 2>/dev/null | tr -d '|\\n')" "$n" "$cls" "$drv" "$blk" "$net"
done
`

export interface UsbDevice {
  /** What to pick and pass in: vendor:product, or the bus-port when another identical device is plugged in. */
  id: string
  name: string
  /** vendor:product, always. */
  code: string
  /** bus-port, like 1-2.3. */
  port: string
  /** Why it cannot be passed in, in words; null when it can. */
  refused: string | null
}

const NET_DRIVERS = /^(r8152|r8153|ax88179_178a|ax88179|ax88772|asix|cdc_ether|cdc_ncm|cdc_eem|cdc_mbim|rndis_host|smsc95xx|smsc75xx|lan78xx|aqc111|qmi_wwan|ipheth|sr9700|dm9601|mcs7830|pegasus|rtl8150|usbnet|net1080|zaurus)$/
const STORAGE_DRIVERS = /^(usb-storage|uas|usblp)$/

/** Why a device must stay with the node, or null. */
export function whyRefused(o: { classes: string[]; drivers: string[]; blk: boolean; net: boolean }): string | null {
  const cls = new Set(o.classes.map(c => c.toLowerCase().padStart(2, '0')))
  if (cls.has('09')) return 'It is a USB hub: everything behind it would go with it.'
  if (cls.has('08') || o.drivers.some(d => STORAGE_DRIVERS.test(d))) return 'It is a storage device (a disk or a memory stick); passing it in would take it away from the node.'
  if (o.blk) return 'A disk sits behind it, which the node may be using.'
  if (cls.has('e0')) return 'It is a wireless controller (Bluetooth or Wi-Fi), which the node may be using.'
  if (o.net || o.drivers.some(d => NET_DRIVERS.test(d))) return 'It is a network adapter, which the node may be using.'
  // Communications and data classes are how serial sticks (Zigbee, Z-Wave) appear, with the serial driver bound; with any other driver they are a modem or a network device.
  if (cls.has('02') || cls.has('0a')) {
    if (o.drivers.some(d => d && d !== 'cdc_acm')) return 'It is a modem or network device, not a serial stick.'
    // The serial driver must really be bound: without it nothing says this is a stick, and it is not passed in on a guess.
    if (!o.drivers.includes('cdc_acm')) return 'It is not recognised as a Zigbee or Z-Wave stick (no serial driver is bound to it).'
  }
  return null
}

export function parseUsb(out: string): UsbDevice[] {
  const rows: Array<UsbDevice & { count?: number }> = []
  const seen = new Set<string>()
  for (const line of String(out ?? '').split('\n')) {
    const m = /^@@usb ([0-9a-f]{4}:[0-9a-f]{4})\|([^|]*)\|([^|]*)\|(\d{1,3}-\d{1,3}(?:\.\d{1,3}){0,5})\|([0-9a-f,]*)\|([^|]*)\|([01])\|([01])$/.exec(line.trim())
    if (!m || seen.has(m[4])) continue
    seen.add(m[4])
    if (m[1].startsWith('1d6b:')) continue
    const clean = (x: string) => x.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    rows.push({
      id: m[1], code: m[1], port: m[4],
      name: [m[2], m[3]].map(clean).filter(Boolean).join(' ').slice(0, 80) || 'USB device',
      refused: whyRefused({ classes: m[5].split(',').filter(Boolean), drivers: m[6].split(',').map(x => x.trim()).filter(Boolean), blk: m[7] === '1', net: m[8] === '1' }),
    })
  }
  const same = new Map<string, number>()
  for (const r of rows) same.set(r.code, (same.get(r.code) ?? 0) + 1)
  // Identical devices are told apart by where they are plugged in.
  return rows.map(({ count: _c, ...r }) => ((same.get(r.code) ?? 0) > 1 ? { ...r, id: r.port } : r))
}

/**
 * What to pass in for each chosen id, or why it cannot be: the device must be plugged in now, must not be one the node needs, and a
 * vendor:product shared by more than one device must be chosen by bus-port. Returns the value for `qm set --usbN host=`.
 */
export function resolveUsb(devices: UsbDevice[], wanted: string[], node: string): { hosts: string[]; errors: string[] } {
  const hosts: string[] = [], errors: string[] = []
  for (const w of wanted) {
    const byId = devices.find(d => d.id === w)
    const shared = devices.filter(d => d.code === w).length > 1
    if (!byId) {
      errors.push(shared ? `More than one device is ${w}; pick the one you mean by where it is plugged in (the list shows each by its bus-port).`
        : `The USB device ${w} is not plugged into ${node}. Plug it in, or pick the node it is on.`)
      continue
    }
    if (byId.refused) { errors.push(`${byId.name} (${w}) cannot be passed in: ${byId.refused}`); continue }
    hosts.push(byId.id)
  }
  return { hosts, errors }
}
