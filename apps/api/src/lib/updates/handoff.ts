// =============================================================================
//  HyperProx — Updates: self handoff
//
//  Two steps would stop HyperProx in the middle of running them: upgrading the
//  guest it lives in, and rebooting the node under that guest. A step the API
//  runs over SSH dies with the API. So for these the API writes a script to a
//  node, starts it detached under systemd (it survives the SSH session and the
//  API), and the script writes its result to a file. The API reads that file
//  when it is back — or straight away, if it never went away.
//
//  The node-reboot script follows the same rule as a normal node reboot: if the
//  node does not come back within the limit it leaves `noout` and HA
//  maintenance ON, so data does not move and guests do not bounce. Clearing them
//  is a person's decision.
// =============================================================================

import type { UpdatesExecutor, GuestRef } from './executor'
import { GUEST_UPGRADE_SCRIPT } from './commands'

export const HANDOFF_DIR = '/var/lib/hyperprox-updates'

export interface HandoffResult { ok: boolean; message: string; finishedAt?: string }

const unit = (jobId: string, stepId: string) => `hyperprox-handoff-${jobId}-${stepId}`.replace(/[^A-Za-z0-9_-]/g, '')
const resultFile = (jobId: string, stepId: string) => `${HANDOFF_DIR}/${unit(jobId, stepId)}.json`

function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'` }

const writeResult = (file: string) => `
result() {  # ok message
  printf '{"ok":%s,"message":"%s","finishedAt":"%s"}\\n' "$1" "$(printf '%s' "$2" | tr -d '"\\\\' | tr '\\n' ' ')" "$(date -Is)" > ${file}.tmp
  mv ${file}.tmp ${file}
}`

/** Upgrade HyperProx's own guest, run on that guest's node. */
export function selfGuestScript(jobId: string, stepId: string, guest: GuestRef): string {
  const file = resultFile(jobId, stepId)
  const inner = Buffer.from(GUEST_UPGRADE_SCRIPT).toString('base64')
  const run = guest.type === 'lxc'
    ? `pct exec ${guest.vmid} -- bash -c 'echo ${inner} | base64 -d | bash'`
    : `qm guest exec ${guest.vmid} --timeout 1800 -- bash -c 'echo ${inner} | base64 -d | bash' | grep -q '"exitcode" : 0'`
  return `#!/bin/bash
${writeResult(file)}
if out=$(${run} 2>&1); then result true "guest ${guest.vmid} upgraded"; else result false "guest ${guest.vmid} upgrade failed: $(echo "$out" | tail -n 5)"; fi
`
}

/**
 * Reboot HyperProx's own node, run on a DIFFERENT node. PVE cluster nodes reach
 * each other as root over SSH, which is what lets the script reboot the target.
 */
export function selfNodeRebootScript(jobId: string, stepId: string, target: string, opts: { ceph: boolean; waitMinutes?: number }): string {
  const file = resultFile(jobId, stepId)
  const wait = opts.waitMinutes ?? 15
  const t = shq(target)
  return `#!/bin/bash
${writeResult(file)}
${opts.ceph ? 'ceph osd set noout || { result false "could not set noout"; exit 1; }' : ''}
ha-manager crm-command node-maintenance enable ${t} || { ${opts.ceph ? 'ceph osd unset noout; ' : ''}result false "could not enable HA maintenance"; exit 1; }
sleep 60   # let HA move guests off
ssh -o BatchMode=yes -o ConnectTimeout=10 root@${t} systemctl reboot || true
sleep 90
deadline=$(( $(date +%s) + ${wait} * 60 ))
back=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  online=$(pvesh get /cluster/status --output-format json | python3 -c 'import json,sys; print(next((n.get("online",0) for n in json.load(sys.stdin) if n.get("type")=="node" and n.get("name")==sys.argv[1]),0))' ${t} 2>/dev/null)
  if [ "$online" = "1" ]; then
    ${opts.ceph
      ? `if ceph osd stat -f json | python3 -c 'import json,sys; s=json.load(sys.stdin); sys.exit(0 if s["num_up_osds"]==s["num_osds"] else 1)' && ceph pg stat | grep -qv -E 'degraded|peering|undersized|recovering|backfill|down|inactive|stale'; then back=1; break; fi`
      : 'back=1; break'}
  fi
  sleep 15
done
if [ "$back" = "1" ]; then
  ha-manager crm-command node-maintenance disable ${t}
  ${opts.ceph ? 'ceph osd unset noout' : ''}
  result true "${target} rebooted and returned; maintenance cleared"
else
  result false "${target} did not return within ${wait} minutes; noout and HA maintenance LEFT ON for a person to clear"
fi
`
}

/** Write the script to the node and start it detached. */
export async function startHandoff(exec: UpdatesExecutor, node: string, jobId: string, stepId: string, script: string): Promise<void> {
  const u = unit(jobId, stepId)
  const b64 = Buffer.from(script).toString('base64')
  const cmd = [
    `mkdir -p ${HANDOFF_DIR}`,
    `rm -f ${resultFile(jobId, stepId)}`,
    `echo ${b64} | base64 -d > ${HANDOFF_DIR}/${u}.sh`,
    `chmod 700 ${HANDOFF_DIR}/${u}.sh`,
    `systemd-run --unit=${u} --collect --quiet /bin/bash ${HANDOFF_DIR}/${u}.sh`,
  ].join(' && ')
  const r = await exec.nodeExec(node, cmd, undefined, 60_000)
  if (r.code !== 0) throw new Error(`could not start the handoff on ${node}: ${r.output.slice(-300)}`)
}

/** The result, or null while the script is still running. Throws when it vanished without one. */
export async function readHandoff(exec: UpdatesExecutor, node: string, jobId: string, stepId: string): Promise<HandoffResult | null> {
  const u = unit(jobId, stepId)
  const r = await exec.nodeExec(node,
    `if [ -f ${resultFile(jobId, stepId)} ]; then cat ${resultFile(jobId, stepId)}; elif systemctl is-active --quiet ${u}; then echo HP_RUNNING; else echo HP_GONE; fi`,
    undefined, 30_000)
  const out = r.output.trim()
  if (out === 'HP_RUNNING') return null
  if (out === 'HP_GONE') throw new Error(`the handoff on ${node} stopped without writing a result`)
  try {
    const j = JSON.parse(out)
    return { ok: j.ok === true, message: String(j.message ?? ''), finishedAt: j.finishedAt }
  } catch {
    throw new Error(`unreadable handoff result on ${node}: ${out.slice(0, 200)}`)
  }
}

/** Where a self step's handoff runs is recorded in its detail, so a restarted API can find it. */
export const handoffTag = (node: string) => `handoff@${node}`
export function handoffNodeOf(detail: string | null | undefined): string | null {
  return /handoff@(\S+)/.exec(detail ?? '')?.[1] ?? null
}
