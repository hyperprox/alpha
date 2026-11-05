// The default VpnStatusSource: a thin client of /api/remote/v1 for pages outside the VPN page (the guest
// drill-down and list badges). See docs/remote-access.md, "API for other pages".

import type { RemoteJob, RemoteProviderId, VpnInstallPreview, VpnMachineStatus, VpnPrefs, VpnSettingsPreview, VpnStatusSource } from '@hyperprox/types'
import { apiJson } from '@/lib/api'

export class VpnApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'VpnApiError' }
}

const enc = encodeURIComponent

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await apiJson<T>(`/api/remote/v1${path}`, method, body)
  if (!r.ok || r.body === null) throw new VpnApiError(r.error ?? `Request failed (${r.status})`, r.status, r.code)
  return r.body
}

export const vpnStatusSource: VpnStatusSource = {
  async list() { return (await call<{ machines: VpnMachineStatus[] }>('/status')).machines },
  async statusFor(machineId) {
    try { return await call<VpnMachineStatus>(`/status/${enc(machineId)}`) }
    catch (e) { if (e instanceof VpnApiError && e.status === 404) return null; throw e }
  },
  guestId: (type, vmid) => `${type}-${vmid}`,
  installPreview: (m, p) => call<VpnInstallPreview>(`/machines/${enc(m)}/${p}/install-preview`),
  async install(m, p) { return { jobId: (await call<{ job: RemoteJob }>(`/machines/${enc(m)}/${p}/install`, 'POST', { confirm: true })).job.id } },
  async uninstall(m, p) { return { jobId: (await call<{ job: RemoteJob }>(`/machines/${enc(m)}/${p}`, 'DELETE')).job.id } },
  async settings(m, p) { return (await call<{ current: VpnPrefs }>(`/machines/${enc(m)}/${p}/settings`)).current },
  previewSettings: (m, p, change) => call<VpnSettingsPreview>(`/machines/${enc(m)}/${p}/settings/preview`, 'POST', { prefs: change }),
  async applySettings(m, p, change) { return { jobId: (await call<{ job: RemoteJob }>(`/machines/${enc(m)}/${p}/settings`, 'POST', { prefs: change, confirm: true })).job.id } },
  async job(id) { return (await call<{ job: RemoteJob }>(`/jobs/${enc(id)}`)).job },
  panelUrl: (m: string, p?: RemoteProviderId) => `/vpn?machine=${enc(m)}${p ? `&provider=${p}` : ''}`,
}
