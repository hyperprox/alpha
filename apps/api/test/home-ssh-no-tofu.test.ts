// Home node SSH without trust on first use: the GPU reader goes through the pinned node runner (no
// StrictHostKeyChecking=no), and Updates connects to the address Proxmox records, never to a node name looked up in DNS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGpuOutput, GPU_SCRIPT } from '../src/lib/gpu'
import { homeNodeAddress } from '../src/lib/updates/executor'

test('the GPU reader no longer shells out to ssh with host-key checking off', () => {
  const src = readFileSync(join(__dirname, '../src/lib/gpu.ts'), 'utf8')
  assert.doesNotMatch(src, /`ssh -o|execAsync\(/)
  assert.doesNotMatch(src, /child_process/)
  assert.match(GPU_SCRIPT, /nvidia-smi --query-gpu/)
})

test('the GPU script\'s output is read, guests named from the cgroup', () => {
  const out = 'NVIDIA GeForce GTX 1070 Ti, 8192, 2048, 6144, 35, 52, 60.5, 180.0\n---\n1234, 1024, /usr/lib/plexmediaserver/Plex Transcoder, 742\n99, 512, python3,\n'
  const info = parseGpuOutput(out, [{ vmid: 742, name: 'plex' }])!
  assert.equal(info.name, 'NVIDIA GeForce GTX 1070 Ti')
  assert.equal(info.vram_pct, 25)
  assert.deepEqual(info.consumers.map(c => [c.pid, c.ct_id, c.ct_name]), [[1234, '742', 'plex'], [99, null, null]])
  assert.equal(parseGpuOutput('nvidia-smi: not found\n'), null)
})

test('Updates connects to the address Proxmox records for a node, never to its name', () => {
  assert.equal(homeNodeAddress({ 'node-a': '192.0.2.11' }, 'node-a'), '192.0.2.11')
  assert.throws(() => homeNodeAddress({}, 'node-a'), /lists no address for node node-a/)
})
