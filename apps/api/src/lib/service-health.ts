// =============================================================================
//  HyperProx — Service Health Checks
// =============================================================================

interface ServiceHealth {
  connected: boolean
  version?:  string
  message?:  string
}

async function checkUrl(url: string, path: string, timeout = 3000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), timeout)
    const res = await fetch(`${url}${path}`, { signal: controller.signal })
    clearTimeout(id)
    return res.ok
  } catch { return false }
}

export async function checkGrafana(): Promise<ServiceHealth> {
  const url = 'http://grafana:3003'
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 3000)
    const res = await fetch(`${url}/api/health`, { signal: controller.signal })
    if (!res.ok) return { connected: false }
    const json = await res.json() as any
    return { connected: true, version: json.version, message: json.database }
  } catch {
    return { connected: false, message: 'unreachable' }
  }
}

export async function checkPrometheus(): Promise<ServiceHealth> {
  const url = 'http://prometheus:9090'
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 3000)
    const res = await fetch(`${url}/-/healthy`, { signal: controller.signal })
    if (!res.ok) return { connected: false }
    return { connected: true, message: 'healthy' }
  } catch {
    return { connected: false, message: 'unreachable' }
  }
}
