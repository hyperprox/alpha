// The apt guard reads options the way apt-get does: -o and -t take a value, so a value is never mistaken for the
// verb (which let `apt-get -o X=Y upgrade` through), and protected packages are refused for remove and
// --only-upgrade too. It is a safety net for HyperProx's own scripts, not a security boundary (see the file).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertAptInstallOnly, aptVerb } from '../src/lib/clusters/script-guard'

test('options and their values are skipped before the verb', () => {
  assert.deepEqual(aptVerb(['-o', 'Dpkg::Options::=--force-confold', 'upgrade']).verb, 'upgrade')
  assert.deepEqual(aptVerb(['-t', 'bookworm-backports', 'install', 'x']).verb, 'install')
  assert.deepEqual(aptVerb(['-q', '-y', 'install', '--no-install-recommends', 'pkg']).rest, ['pkg'])
})

test('upgrades hidden behind an option value are refused', () => {
  for (const bad of [
    'apt-get -o Dpkg::Options::=--force-confold upgrade',
    'apt-get -o APT::Get::Assume-Yes=true dist-upgrade',
    'apt-get -t bookworm-backports install intel-gpu-tools',
    'apt-get -c /tmp/evil.conf install intel-gpu-tools',
    'apt-get -o APT::Get::Upgrade=true install intel-gpu-tools',
    'apt-get -y install --only-upgrade intel-gpu-tools',
    'apt-get -y remove pve-manager',
    'apt-get -y purge proxmox-kernel-6.8',
    'apt-get -y install proxmox-default-kernel',
    'apt-get -y install "nvidia-driver"',
    'apt-get --allow-change-held-packages=true install x',
  ]) assert.throws(() => assertAptInstallOnly(`set -u\n${bad}\n`), /Refused/, bad)
})

test('HyperProx\'s own install and remove lines still pass', () => {
  for (const ok of [
    'apt-get -q -y install --no-install-recommends -o Dpkg::Options::=--force-confold intel-gpu-tools',
    'apt-get -s -q install --no-install-recommends intel-gpu-tools',
    'apt-get -q -y remove prometheus-node-exporter >/dev/null 2>&1',
    'apt-get update',
    'command -v apt-get >/dev/null',
  ]) assert.doesNotThrow(() => assertAptInstallOnly(ok), ok)
})
