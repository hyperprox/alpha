// =============================================================================
//  HyperProx — Home Assistant: the USB devices on a node, for the wizard's "pass in a stick" question
//
//  A read-only look over the node's login at what is plugged in, from the kernel's own list (so it works without lsusb).
//  Hubs and the node's own controllers are left out. The answer is vendor:product codes with the names the device gives.
// =============================================================================

export const HAVM_USB_SCRIPT = `for d in /sys/bus/usb/devices/*; do
  [ -f "$d/idVendor" ] || continue
  c=$(cat "$d/bDeviceClass" 2>/dev/null || echo 00)
  [ "$c" = 09 ] && continue
  printf '@@usb %s:%s|%s|%s\\n' "$(cat "$d/idVendor")" "$(cat "$d/idProduct")" "$(cat "$d/manufacturer" 2>/dev/null | tr -d '|\\n')" "$(cat "$d/product" 2>/dev/null | tr -d '|\\n')"
done
`

export interface UsbDevice { id: string; name: string }

export function parseUsb(out: string): UsbDevice[] {
  const seen = new Set<string>(), list: UsbDevice[] = []
  for (const line of String(out ?? '').split('\n')) {
    const m = /^@@usb ([0-9a-f]{4}:[0-9a-f]{4})\|([^|]*)\|([^|]*)$/.exec(line.trim())
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    // Linux root hubs are class 09 and skipped by the script; a Linux Foundation vendor id is one that slipped through.
    if (m[1].startsWith('1d6b:')) continue
    list.push({ id: m[1], name: [m[2], m[3]].map(x => x.replace(/[\u0000-\u001f\u007f]/g, '').trim()).filter(Boolean).join(' ').slice(0, 80) || 'USB device' })
  }
  return list
}
