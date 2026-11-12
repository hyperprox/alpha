/** Bytes as the pages write them: "38.4 GB", "512 MB", "0 B". */
export function bytes(n: number): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} TB`
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)} MB`
  return `${Math.max(1, Math.round(v / 1e3))} KB`
}
