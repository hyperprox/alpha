// The cluster's name for the top bar: Proxmox's own cluster name (GET /api/proxmox/cluster-name), else the name
// the build was given (NEXT_PUBLIC_CLUSTER_NAME), else nothing.
import { useEffect, useState } from 'react'

export function chooseClusterName(fromApi: string | null | undefined, fromEnv: string | null | undefined): string {
  const a = (fromApi ?? '').trim()
  if (a) return a
  return (fromEnv ?? '').trim()
}

let cached: string | null | undefined

/** Read once per page load; a failed or empty answer falls back to the build's name. */
export function useClusterName(envName = process.env.NEXT_PUBLIC_CLUSTER_NAME ?? ''): string {
  const [apiName, setApiName] = useState<string | null | undefined>(cached)
  useEffect(() => {
    if (cached !== undefined) return
    let alive = true
    fetch('/api/proxmox/cluster-name').then(r => r.json()).then(j => {
      const n = j?.success !== false && typeof j?.data?.name === 'string' ? j.data.name : typeof j?.name === 'string' ? j.name : null
      cached = n
      if (alive) setApiName(n)
    }).catch(() => { /* the build's name stands in */ })
    return () => { alive = false }
  }, [])
  return chooseClusterName(apiName, envName)
}
