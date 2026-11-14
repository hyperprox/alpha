// Whether a guest's config has a plain bind mount (a host path as a mount point), which blocks snapshots. CSS-free.

/** True when any mpN of the config is a host path ("/srv/data,mp=/data"), not a storage volume. */
export function hasBindMount(config: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(config ?? {}).some(([k, v]) => /^mp\d+$/.test(k) && String(v ?? '').trim().startsWith('/'))
}
