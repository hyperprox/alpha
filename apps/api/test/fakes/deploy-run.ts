// Typed deploy-service fields and the run built from them, for executor tests.
import type { DeployRun } from "../../src/lib/wizard-executor"
import { deployService, type DeployFields } from "../../src/lib/ai/templates/deploy-service"

export const DEBIAN = "tmpl:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"

export function fields(over: Partial<DeployFields> = {}): DeployFields {
  return {
    service: "uptime-kuma", exposure: "lan", node: "alpha", vmid: 250, ip: "10.0.0.37/24", gateway: "10.0.0.1",
    bridge: "vmbr0", storage: "pool", template: DEBIAN, memory_mb: 512, disk_gb: 8, cores: 1,
    hostname: "uptime-kuma", features: "nesting=1", packages: ["ca-certificates", "curl", "docker.io", "docker-compose"],
    ...over,
  }
}

const asFields = (f: DeployFields) =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { value: v, source: "user" as const }]))

export const runOf = (f: DeployFields, steps = deployService.steps(asFields(f))): DeployRun =>
  ({ template: "deploy-service", version: 1, owner: "admin@example.com", fields: f, steps })
