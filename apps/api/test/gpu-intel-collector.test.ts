// The Intel GPU collector (packages/hardware/node/intel-gpu-textfile.py) and the remote-monitoring step that
// installs it (lib/clusters/monitoring.ts), run for real against a pretend node in a temp folder: stubbed
// systemctl, dpkg-query, apt-get, curl, ip and intel_gpu_top, a fake /sys, the real python3 and bash.
// Nothing here reaches a real node, a network or a service.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAuditSink } from '../src/lib/audit'
import { setClusterStore, loadClusters } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import {
  intelInstallScript, intelRemoveScript, installScript, removeScript, SCAN_SCRIPT, assertSafeScript, assertAptInstallOnly,
  parseScan, scanMonitoring, previewMonitoring, applyMonitoring, clearMonitoringPlans, intelOutcome, type MonitoringDeps,
} from '../src/lib/clusters/monitoring'

setAuditSink({ write: async () => {} })

const COLLECTOR = join(__dirname, '..', '..', '..', 'packages', 'hardware', 'node', 'intel-gpu-textfile.py')
const havePython = spawnSync('python3', ['--version']).status === 0
const skip = !havePython && 'python3 not installed'

// ── intel_gpu_top -J samples, as several versions print them ─────────────────────────────────────────────────

/** igt 1.25/1.26: objects separated by commas, no surrounding array; a single GPU power value. */
const OLD_STREAM = `{
	"period": {
		"duration": 1000.123,
		"unit": "ms"
	},
	"frequency": {
		"requested": 350.0,
		"actual": 300.0,
		"unit": "MHz"
	},
	"interrupts": {
		"count": 0.0,
		"unit": "irq/s"
	},
	"rc6": {
		"value": 98.5,
		"unit": "%"
	},
	"power": {
		"value": 0.42,
		"unit": "W"
	},
	"imc-bandwidth": {
		"reads": 120.5,
		"writes": 40.25,
		"unit": "MiB/s"
	},
	"engines": {
		"Render/3D/0": {
			"busy": 12.5,
			"sema": 0.0,
			"wait": 0.0,
			"unit": "%"
		},
		"Blitter/0": {
			"busy": 0.0,
			"sema": 0.0,
			"wait": 0.0,
			"unit": "%"
		},
		"Video/0": {
			"busy": 37.25,
			"sema": 0.0,
			"wait": 0.0,
			"unit": "%"
		},
		"VideoEnhance/0": {
			"busy": 4.0,
			"sema": 0.0,
			"wait": 0.0,
			"unit": "%"
		}
	}
},
{
	"period": { "duration": 1000.0, "unit": "ms" },
	"engines": { "Render/3D/0": { "busy": 20.0, "sema": 0.0, "wait": 0.0, "unit": "%" }, "Video/0": { "busy": 60.0, "sema": 0.0, "wait": 0.0, "unit": "%" } }
}`

/** igt 1.27 and later: wrapped in [ ], GPU and Package power, per-client blocks whose names can hold braces. */
const ARRAY_STREAM = `[
{
	"period": { "duration": 5001.2, "unit": "ms" },
	"frequency": { "requested": 1100.0, "actual": 1050.0, "unit": "MHz" },
	"interrupts": { "count": 812.0, "unit": "irq/s" },
	"rc6": { "value": 40.0, "unit": "%" },
	"power": { "GPU": 3.2, "Package": 11.8, "unit": "W" },
	"imc-bandwidth": { "reads": 2048.0, "writes": 512.0, "unit": "MiB/s" },
	"engines": {
		"Render/3D/0": { "busy": 5.0, "sema": 0.0, "wait": 0.0, "unit": "%" },
		"Blitter/0": { "busy": 1.0, "sema": 0.0, "wait": 0.0, "unit": "%" },
		"Video/0": { "busy": 81.5, "sema": 0.0, "wait": 0.0, "unit": "%" },
		"Video/1": { "busy": 10.0, "sema": 0.0, "wait": 0.0, "unit": "%" },
		"VideoEnhance/0": { "busy": 22.0, "sema": 0.0, "wait": 0.0, "unit": "%" }
	},
	"clients": {
		"4242": { "name": "Transcoder {x}", "pid": "4242", "engine-classes": { "Video": { "busy": "81.5", "unit": "%" } } }
	}
}
]`

/** Newer default view: one row per engine class, no instance number; a compute engine; no power. */
const CLASS_STREAM = `[
{
	"period": { "duration": 2000.0, "unit": "ms" },
	"frequency": { "requested": 900.0, "actual": 900.0, "unit": "MHz" },
	"engines": {
		"Render/3D": { "busy": 3.0, "sema": 0.0, "wait": 0.0, "unit": "%" },
		"Blitter": { "busy": 0.0, "sema": 0.0, "wait": 0.0, "unit": "%" },
		"Video": { "busy": 15.0, "sema": 0.0, "wait": 0.0, "unit": "%" },
		"VideoEnhance": { "busy": 0.0, "sema": 0.0, "wait": 0.0, "unit": "%" },
		"Compute": { "busy": 7.0, "unit": "%" }
	}
}
]`

/** An xe-driver run of a recent tool: engines with busy only, nothing else. */
const XE_STREAM = `[{"engines":{"Render/3D":{"busy":2.5,"unit":"%"},"Video":{"busy":0.0,"unit":"%"}}}]`

function parse(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpx-igt-'))
  writeFileSync(join(dir, 'out.json'), text)
  return execFileSync('python3', [COLLECTOR, '--parse', join(dir, 'out.json')], { encoding: 'utf8' })
}
const val = (prom: string, name: string) => {
  const m = new RegExp(`^${name}\\{pci="0000:00:02\\.0",card="card0"\\} (\\S+)$`, 'm').exec(prom)
  return m ? Number(m[1]) : null
}

test('parser: the old comma-separated stream, the last whole sample wins, and the single power value is the GPU\'s', { skip }, () => {
  const p = parse(OLD_STREAM)
  assert.equal(val(p, 'igpu_engines_render_3d_0_busy'), 20)
  assert.equal(val(p, 'igpu_engines_video_0_busy'), 60)
  assert.match(p, /^hyperprox_intel_gpu_info\{pci="0000:00:02\.0",card="card0",driver="i915",status="ok",reason=""\} 1$/m)
  // The first sample's fields are gone with it: only what the latest sample reports is served.
  assert.equal(val(p, 'igpu_frequency_actual'), null)
  const first = parse(OLD_STREAM.slice(0, OLD_STREAM.indexOf('},\n{') + 1))
  assert.equal(val(first, 'igpu_power_gpu'), 0.42)
  assert.equal(val(first, 'igpu_imc_bandwidth_reads'), 120.5)
  assert.equal(val(first, 'igpu_engines_video_enhance_0_busy'), 4)
  assert.equal(val(first, 'igpu_frequency_actual'), 300)
  assert.equal(val(first, 'igpu_rc6'), 98.5)
})

test('parser: the array form, GPU and package power, a second video engine, braces inside a client name', { skip }, () => {
  const p = parse(ARRAY_STREAM)
  assert.equal(val(p, 'igpu_engines_video_0_busy'), 81.5)
  assert.equal(val(p, 'igpu_engines_video_1_busy'), 10)
  assert.equal(val(p, 'igpu_power_gpu'), 3.2)
  assert.equal(val(p, 'igpu_power_package'), 11.8)
  assert.equal(val(p, 'igpu_frequency_requested'), 1100)
  assert.ok(!/clients|Transcoder/.test(p), 'per-client figures are not exported')
  // Valid Prometheus text: every family's HELP and TYPE once, before its samples.
  const names = p.split('\n').filter(l => l.startsWith('# TYPE ')).map(l => l.split(' ')[2])
  assert.equal(new Set(names).size, names.length)
})

test('parser: engine classes without an instance number get _0, as the exporter names them; compute too', { skip }, () => {
  const p = parse(CLASS_STREAM)
  assert.equal(val(p, 'igpu_engines_render_3d_0_busy'), 3)
  assert.equal(val(p, 'igpu_engines_video_enhance_0_busy'), 0)
  assert.equal(val(p, 'igpu_engines_compute_0_busy'), 7)
  assert.equal(val(p, 'igpu_power_gpu'), null)
})

test('parser: an xe-driver sample with engines only still counts', { skip }, () => {
  const p = parse(XE_STREAM)
  assert.equal(val(p, 'igpu_engines_render_3d_0_busy'), 2.5)
  assert.match(p, /status="ok"/)
})

test('parser: garbage, empty, a cut-off sample and a sample with no engines give no figures and say so', { skip }, () => {
  for (const bad of ['', 'intel_gpu_top: Failed to initialize PMU! (Permission denied)\n', '{"period": {"duration": 1000', '[{"period":{"duration":1000,"unit":"ms"}}]', '{{{{', '[1,2,3]', '{"engines": "nope"}']) {
    const p = parse(bad)
    assert.equal(val(p, 'igpu_engines_render_3d_0_busy'), null, JSON.stringify(bad))
    assert.match(p, /status="error",reason="no sample in the output"/, JSON.stringify(bad))
  }
  // A whole sample followed by a cut-off one: the whole one is used.
  const p = parse(XE_STREAM.slice(0, -1) + ',{"engines":{"Render/3D":{"busy":')
  assert.equal(val(p, 'igpu_engines_render_3d_0_busy'), 2.5)
})

// ── A pretend node ───────────────────────────────────────────────────────────────────────────────────────────

interface NodeOpts {
  intel?: boolean
  driver?: string
  toolPreinstalled?: boolean
  /** What apt-get -s install intel-gpu-tools prints. */
  sim?: string
  /** What intel_gpu_top does: print a sample, or complain on stderr and exit. */
  tool?: { sample?: string; stderr?: string; code?: number }
  /** What apt-get -s remove prints (default: one Remv line per package named). */
  simRemove?: string
  python?: boolean
}

function fakeNode(o: NodeOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hpx-inode-'))
  const st = join(root, 'stub-state'), bin = join(root, 'bin'), tools = join(root, 'tools')
  for (const d of [st, bin, tools]) mkdirSync(d, { recursive: true })
  const S = st
  const stub = (dir: string, n: string, body: string) => { writeFileSync(join(dir, n), `#!/bin/bash\n${body}\n`); chmodSync(join(dir, n), 0o755) }

  // /sys: card0 is the GPU (Intel or not), card0-DP-1 a connector, as on a real node.
  const dev = join(root, 'sys/devices/pci0000:00/0000:00:02.0')
  mkdirSync(dev, { recursive: true })
  mkdirSync(join(root, 'sys/bus/pci/drivers', o.driver ?? 'i915'), { recursive: true })
  writeFileSync(join(dev, 'vendor'), o.intel === false ? '0x10de\n' : '0x8086\n')
  symlinkSync(join(root, 'sys/bus/pci/drivers', o.driver ?? 'i915'), join(dev, 'driver'))
  mkdirSync(join(root, 'sys/class/drm/card0'), { recursive: true })
  symlinkSync(dev, join(root, 'sys/class/drm/card0/device'))
  mkdirSync(join(root, 'sys/class/drm/card0-DP-1'), { recursive: true })

  writeFileSync(join(st, 'sim-install'), o.sim ?? 'NOTE: simulation\nInst libdw1 (0.188-2.1 Debian:12/stable [amd64])\nInst intel-gpu-tools (1.27.1-1 Debian:12/stable [amd64])\nConf libdw1 (0.188-2.1 Debian:12/stable [amd64])\nConf intel-gpu-tools (1.27.1-1 Debian:12/stable [amd64])\n')
  if (o.simRemove !== undefined) writeFileSync(join(st, 'sim-remove'), o.simRemove)
  // node_exporter is already running here (the step before this one set it up).
  writeFileSync(join(st, 'active-prometheus-node-exporter'), '')

  const t = o.tool ?? { sample: XE_STREAM }
  const toolBody = t.sample !== undefined
    ? `cat <<'J'\n${t.sample}\nJ\nexec sleep 30`
    : `echo ${JSON.stringify(t.stderr ?? 'boom')} >&2; exit ${t.code ?? 1}`
  writeFileSync(join(st, 'tool-body'), toolBody)
  const placeTool = `{ printf '#!/bin/bash\\n'; cat ${S}/tool-body; } > ${tools}/intel_gpu_top; chmod 755 ${tools}/intel_gpu_top`
  if (o.toolPreinstalled) { execFileSync('bash', ['-c', placeTool]); writeFileSync(join(st, 'pkg-intel-gpu-tools'), '') }

  stub(bin, 'systemctl', `n="\${@: -1}"; n="\${n%.service}"
case "$1" in
  is-enabled) [ -f ${S}/enabled-$n ];; is-active) [ -f ${S}/active-$n ];;
  enable) touch ${S}/enabled-$n;; disable) rm -f ${S}/enabled-$n; [ "$2" = --now ] && rm -f ${S}/active-$n; true;;
  restart|start) touch ${S}/active-$n;; stop) rm -f ${S}/active-$n;; *) true;; esac`)
  stub(bin, 'dpkg-query', `[ -f ${S}/pkg-$3 ] && echo 'install ok installed'`)
  stub(bin, 'apt-get', `echo "$*" >> ${S}/apt-log
pk=(); for a in "$@"; do case "$a" in -*|install|remove|update) ;; *) pk+=("$a");; esac; done
case " $* " in
  *" -s "*" install "*) cat ${S}/sim-install; [ -f ${S}/sim-install-fails ] && exit 100; true;;
  *" -s "*" remove "*) if [ -f ${S}/sim-remove ]; then cat ${S}/sim-remove; else for p in "\${pk[@]}"; do echo "Remv $p [1.0]"; done; fi;;
  *" install "*) for p in $(awk '$1 == "Inst" {print $2}' ${S}/sim-install); do touch ${S}/pkg-$p; done; ${placeTool};;
  *" remove "*) for p in "\${pk[@]}"; do rm -f ${S}/pkg-$p; [ "$p" = intel-gpu-tools ] && rm -f ${tools}/intel_gpu_top; done;;
esac; true`)
  stub(bin, 'curl', `[ -f ${S}/active-prometheus-node-exporter ] || exit 7
echo 'node_exporter_build_info{version="1.5.0"} 1'
[ -f ${S}/active-hyperprox-intel-gpu-textfile ] && cat ${root}/var/lib/prometheus/node-exporter/*.prom 2>/dev/null; true`)
  stub(bin, 'ip', `echo '3: tailscale0    inet 10.0.0.7/32 scope global tailscale0'`)
  stub(bin, 'sleep', 'true')

  // python3 is looked for with `command -v`: a node without it gets a PATH where it cannot be found.
  const sysPath = process.env.PATH ?? '/usr/bin:/bin'
  if (o.python === false) { for (const c of ['awk', 'grep', 'sed', 'cat', 'rm', 'mkdir', 'printf', 'tr', 'head', 'rmdir', 'touch', 'mv', 'chmod', 'dirname', 'timeout', 'basename', 'readlink', 'sort', 'paste']) { const w = spawnSync('bash', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim(); if (w.startsWith('/')) symlinkSync(w, join(bin, c)) } }
  const env = { ...process.env, PATH: o.python === false ? `${bin}:${tools}` : `${bin}:${tools}:${sysPath}`, HPX_SYSROOT: root, SSH_CONNECTION: '10.0.0.1 5555 10.0.0.7 22' }
  const run = (script: string) => execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8', env, timeout: 60_000 })
  const has = (p: string) => existsSync(join(root, p))
  const pkgs = () => readdirSync(st).filter(f => f.startsWith('pkg-')).map(f => f.slice(4)).sort()
  const aptLog = () => (existsSync(join(st, 'apt-log')) ? readFileSync(join(st, 'apt-log'), 'utf8') : '')
  const prom = () => (has('var/lib/prometheus/node-exporter/hyperprox_intel_gpu.prom') ? readFileSync(join(root, 'var/lib/prometheus/node-exporter/hyperprox_intel_gpu.prom'), 'utf8') : null)
  const svc = () => ({ enabled: existsSync(join(st, 'enabled-hyperprox-intel-gpu-textfile')), active: existsSync(join(st, 'active-hyperprox-intel-gpu-textfile')) })
  return { root, st, run, has, pkgs, aptLog, prom, svc, env }
}
const resultOf = (out: string) => out.trim().split('\n').filter(l => l.startsWith('HPX-RESULT')).pop() ?? ''
const left = (n: ReturnType<typeof fakeNode>) => ({
  unit: n.has('etc/systemd/system/hyperprox-intel-gpu-textfile.service'),
  collector: n.has('usr/local/lib/hyperprox/intel-gpu-textfile.py'),
  figures: n.prom() !== null,
  prior: n.has('etc/hyperprox/intel-gpu-prior'),
  textdir: n.has('var/lib/prometheus/node-exporter'),
})
const NOTHING = { unit: false, collector: false, figures: false, prior: false, textdir: false }

// ── The collector on its own ─────────────────────────────────────────────────────────────────────────────────

test('collector: one Intel GPU found through /sys, a sample written with its PCI address and driver', { skip }, () => {
  const n = fakeNode({ toolPreinstalled: true, tool: { sample: ARRAY_STREAM } })
  const dir = join(n.root, 'out'); mkdirSync(dir)
  const r = spawnSync('python3', [COLLECTOR, '--once', '--interval', '1', '--dir', dir], { env: n.env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.status, 0, r.stderr)
  const p = readFileSync(join(dir, 'hyperprox_intel_gpu.prom'), 'utf8')
  assert.match(p, /^hyperprox_intel_gpu_info\{pci="0000:00:02\.0",card="card0",driver="i915",status="ok",reason=""\} 1$/m)
  assert.match(p, /^igpu_engines_video_0_busy\{pci="0000:00:02\.0",card="card0"\} 81\.5$/m)
  assert.match(p, /^hyperprox_intel_gpu_sample_timestamp_seconds\{pci="0000:00:02\.0",card="card0"\} \d+\.\d+$/m)
})

test('collector: intel_gpu_top missing, a GPU it does not support, and no permission each say so, with no figures', { skip }, () => {
  const cases: Array<[NodeOpts, RegExp, number]> = [
    [{}, /status="no_tool",reason="intel_gpu_top is not installed \(package intel-gpu-tools\)"/, 3],
    [{ toolPreinstalled: true, driver: 'xe', tool: { stderr: 'No device filter specified and no discrete/integrated i915 devices found', code: 1 } }, /driver="xe",status="unsupported"/, 3],
    [{ toolPreinstalled: true, tool: { stderr: 'Failed to initialize PMU! (Permission denied)', code: 1 } }, /status="no_permission"/, 3],
    [{ toolPreinstalled: true, tool: { stderr: 'something odd happened', code: 2 } }, /status="error",reason="something odd happened"/, 3],
  ]
  for (const [o, re, code] of cases) {
    const n = fakeNode(o)
    const dir = join(n.root, 'out'); mkdirSync(dir)
    const r = spawnSync('python3', [COLLECTOR, '--once', '--dir', dir], { env: n.env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, code, r.stderr)
    const p = readFileSync(join(dir, 'hyperprox_intel_gpu.prom'), 'utf8')
    assert.match(p, re)
    assert.ok(!/^igpu_/m.test(p), 'no figures without a sample')
  }
})

test('collector: no Intel GPU, an empty file and a clean exit', { skip }, () => {
  const n = fakeNode({ intel: false, toolPreinstalled: true })
  const dir = join(n.root, 'out'); mkdirSync(dir)
  const r = spawnSync('python3', [COLLECTOR, '--once', '--dir', dir], { env: n.env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.status, 0)
  assert.equal(readFileSync(join(dir, 'hyperprox_intel_gpu.prom'), 'utf8').trim(), '')
})

// ── The install step and Remove ──────────────────────────────────────────────────────────────────────────────

test('install: intel-gpu-tools and its new library added, the service on, node_exporter serves the figures; Remove takes exactly that away', { skip }, () => {
  const n = fakeNode()
  const r = resultOf(n.run(intelInstallScript()))
  assert.match(r, /\tdone\tIntel GPU figures measured \(1 GPU\), served by node_exporter on 10\.0\.0\.7:9100; no new port/)
  assert.deepEqual(n.pkgs(), ['intel-gpu-tools', 'libdw1'])
  assert.deepEqual(n.svc(), { enabled: true, active: true })
  assert.match(n.prom()!, /status="ok"/)
  const unit = readFileSync(join(n.root, 'etc/systemd/system/hyperprox-intel-gpu-textfile.service'), 'utf8')
  assert.match(unit, /ExecStart=\/usr\/bin\/python3 \/usr\/local\/lib\/hyperprox\/intel-gpu-textfile\.py --dir \/var\/lib\/prometheus\/node-exporter --interval 5/)
  assert.match(unit, /RestartPreventExitStatus=3/)
  assert.ok(!/ListenStream|--port/.test(unit), 'no port of its own')
  // apt was asked first, then told to install the one package, and nothing else.
  const log = n.aptLog().trim().split('\n')
  assert.deepEqual(log.map(l => l.replace(/ -o \S+/g, '')), ['-s -q install --no-install-recommends intel-gpu-tools', '-q -y install --no-install-recommends intel-gpu-tools'])
  assert.equal(readFileSync(join(n.root, 'etc/hyperprox/intel-gpu-added'), 'utf8').trim().split('\n').sort().join(','), 'intel-gpu-tools,libdw1')

  // Again: already there.
  assert.match(resultOf(n.run(intelInstallScript())), /\talready\tIntel GPU figures already measured/)

  const rm = resultOf(n.run(intelRemoveScript()))
  assert.match(rm, /\tdone\tIntel GPU monitoring removed; the node is as it was before/)
  assert.deepEqual(n.pkgs(), [], 'exactly the two added packages are gone')
  assert.match(n.aptLog(), /-q -y remove +(libdw1 intel-gpu-tools|intel-gpu-tools libdw1)/)
  assert.deepEqual(left(n), NOTHING, 'no service, collector, figures, record or folder left')
  assert.deepEqual(n.svc(), { enabled: false, active: false })
  assert.match(resultOf(n.run(intelRemoveScript())), /\talready\t/)
})

test('install: an intel-gpu-tools that was already there is used, and Remove leaves it installed', { skip }, () => {
  const n = fakeNode({ toolPreinstalled: true })
  assert.match(resultOf(n.run(intelInstallScript())), /\tdone\t/)
  assert.equal(n.aptLog(), '', 'apt was not touched at all')
  assert.match(resultOf(n.run(intelRemoveScript())), /\tdone\t.*as it was before/)
  assert.deepEqual(n.pkgs(), ['intel-gpu-tools'])
  assert.equal(n.aptLog(), '')
})

test('install: a GPU intel_gpu_top does not support is reported "not supported", and nothing is left installed', { skip }, () => {
  const n = fakeNode({ driver: 'xe', tool: { stderr: 'No device filter specified and no discrete/integrated i915 devices found', code: 1 } })
  const r = resultOf(n.run(intelInstallScript()))
  assert.match(r, /\tskipped\tnot supported on this GPU: intel_gpu_top does not support this GPU or its driver \(driver xe\); nothing was left installed/)
  assert.deepEqual(n.pkgs(), [], 'the package it had added is removed again')
  assert.deepEqual(left(n), NOTHING)
  assert.deepEqual(intelOutcome({ status: 'skipped', reason: r.split('\t')[2] }), { status: 'unsupported', reason: r.split('\t')[2] })
})

test('install: no permission for the perf counters is a failure, rolled back', { skip }, () => {
  const n = fakeNode({ tool: { stderr: 'Failed to initialize PMU! (Permission denied)', code: 1 } })
  assert.match(resultOf(n.run(intelInstallScript())), /\tfailed\tthe GPU perf counters could not be opened.*rolled back/)
  assert.deepEqual(n.pkgs(), [])
  assert.deepEqual(left(n), NOTHING)
})

test('install: an upgrade, a removal, or a kernel/NVIDIA/Proxmox package in apt\'s plan means nothing is installed', { skip }, () => {
  const plans = [
    'Inst libc6 [2.36-9] (2.36-9+deb12u9 Debian:12/stable [amd64])\nInst intel-gpu-tools (1.27.1-1 Debian:12/stable [amd64])\n',
    'Remv some-package [1.0]\nInst intel-gpu-tools (1.27.1-1 Debian:12/stable [amd64])\n',
    'Inst proxmox-kernel-7.0 (7.0.1 Proxmox [amd64])\nInst intel-gpu-tools (1.27.1-1 Debian:12/stable [amd64])\n',
    'Inst libnvidia-ml1 (580 Debian [amd64])\nInst intel-gpu-tools (1.27.1-1 Debian:12/stable [amd64])\n',
    'Inst linux-headers-amd64 (6.1 Debian [amd64])\nInst intel-gpu-tools (1.27.1-1 Debian:12/stable [amd64])\n',
  ]
  for (const sim of plans) {
    const n = fakeNode({ sim })
    const r = resultOf(n.run(intelInstallScript()))
    assert.match(r, /\tfailed\t.*(would upgrade or remove|which HyperProx never touches|HyperProx never touches those).*rolled back/, sim)
    assert.deepEqual(n.pkgs(), [], sim)
    assert.ok(!/-y install/.test(n.aptLog()), `${sim}: no real install was run`)
    assert.ok(!/(dist-|full-)?upgrade|update/.test(n.aptLog()), 'never an upgrade, never a list refresh')
    assert.deepEqual(left(n), NOTHING)
  }
})

test('install: no Intel GPU, no python3, or a LAN address: nothing is done', { skip }, () => {
  assert.match(resultOf(fakeNode({ intel: false }).run(intelInstallScript())), /\tskipped\tno Intel GPU on this node/)
  assert.match(resultOf(fakeNode({ python: false }).run(intelInstallScript())), /\tskipped\tneeds python3/)
  const n = fakeNode()
  const lan = execFileSync('/bin/bash', ['-c', intelInstallScript()], { encoding: 'utf8', env: { ...n.env, SSH_CONNECTION: '10.0.0.1 5555 192.0.2.9 22' } })
  assert.match(resultOf(lan), /\tfailed\t192\.0\.2\.9 is on no interface, not a Tailscale or WireGuard link/)
  assert.deepEqual(n.pkgs(), [])
})

test('remove: if apt would take anything else with the added packages, they are left installed and the answer says why', { skip }, () => {
  const n = fakeNode({ simRemove: 'Remv someones-tool [2.0]\nRemv intel-gpu-tools [1.27]\nRemv libdw1 [0.188]\n' })
  assert.match(resultOf(n.run(intelInstallScript())), /\tdone\t/)
  const rm = resultOf(n.run(intelRemoveScript()))
  assert.match(rm, /\tdone\tIntel GPU monitoring removed; left +(intel-gpu-tools libdw1|libdw1 intel-gpu-tools) installed: removing them now would also remove someones-tool/)
  assert.deepEqual(n.pkgs(), ['intel-gpu-tools', 'libdw1'])
  assert.ok(!/-y remove/.test(n.aptLog()))
  assert.equal(left(n).unit, false)
  assert.equal(left(n).collector, false)
})

// ── The guards ───────────────────────────────────────────────────────────────────────────────────────────────

test('guard: every monitoring script passes; any upgrade, hold change, boot-kernel change or protected package is refused', () => {
  for (const s of [installScript({ amdGpu: true, intelGpu: true }), removeScript(), intelInstallScript(), intelRemoveScript(), SCAN_SCRIPT]) {
    assert.doesNotThrow(() => assertSafeScript(s))
    assert.doesNotThrow(() => assertAptInstallOnly(s))
  }
  for (const bad of [
    'apt-get -y dist-upgrade', 'apt-get -y full-upgrade', 'apt-get -q -y upgrade', 'apt full-upgrade -y', 'apt install foo', 'apt-get autoremove -y',
    'apt-mark unhold proxmox-kernel-7.0', 'proxmox-boot-tool kernel unpin', 'dpkg -i ./x.deb', 'dpkg --purge foo', 'aptitude safe-upgrade',
    'apt-get install -y proxmox-kernel-7.0', 'apt-get -y install nvidia-driver', 'apt-get -y install linux-image-amd64', 'apt-get -y install --allow-change-held-packages intel-gpu-tools',
    'x=1; apt-get -y purge intel-gpu-tools', 'unattended-upgrade -d',
  ]) assert.throws(() => assertAptInstallOnly(`set -u\n${bad}\n`), /Refused/, bad)
  // Words in comments and messages are not commands.
  assert.doesNotThrow(() => assertAptInstallOnly('# there is no `apt upgrade` of any kind\necho "apt cannot install it here"'))
})

test('the install script writes nothing outside its own paths and the textfile folder, and names no port', () => {
  const s = intelInstallScript()
  assert.ok(!/--port|9101|8081|ListenStream/.test(s.replace(/# .*$/gm, '')))
  assert.ok(!/perf_event_paranoid\s*=|sysctl -w/.test(s), 'kernel.perf_event_paranoid is never changed')
  assert.ok(!/apt-get -q update/.test(s.slice(s.indexOf('hp_install_only()'))), 'no list refresh in the Intel step')
})

// ── Scan, preview, apply ─────────────────────────────────────────────────────────────────────────────────────

const SCAN_OUT = (extra: string) => `listen=10.0.0.7\niface=tailscale0\npackage=absent\nservice=inactive\nlistening=\namd=no\nours=no\ninstalled_by_us=no\n${extra}`

test('scan: Intel GPU, driver, python3 and an installed collector are read', () => {
  const f = parseScan('pve', 'pve1.example', SCAN_OUT('intel=yes\nintel_driver=i915\npython3=yes\nintel_gpu_top=no\nintel_ours=yes'))
  assert.deepEqual([f.intel, f.intelDriver, f.python3, f.intelGpuTop, f.intelOurs], [true, 'i915', true, false, true])
  assert.equal(parseScan('pve', null, SCAN_OUT('intel_driver=$(rm -rf /)')).intelDriver, null)
})

async function remoteWith(monitoring: Record<string, any> = {}) {
  const store = new MemoryClusterStore()
  await store.upsert({ id: 'c0123456789', name: 'Remote server', kind: 'remote', address: 'pve1.example', port: 8006, note: '', certFingerprint: 'AA', certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: { pve: 'pve1.example' }, allowedRoots: [], monitoring, plexUrl: null, createdBy: 'x' })
  setClusterStore(store); await loadClusters(); clearMonitoringPlans()
  return store
}

function deps(scan: string, answer: (script: string) => string, ran: string[], metrics = 'node_exporter_build_info{} 1\nhyperprox_intel_gpu_info{pci="0000:00:02.0",card="card0",driver="i915",status="ok",reason=""} 1') {
  const d: MonitoringDeps = {
    nodes: async () => ['pve'], hasLogin: async () => true, reachable: async () => true,
    async run(_h, script) {
      if (script === SCAN_SCRIPT) return { code: 0, output: scan }
      const kind = script.includes('hp_install_only intel-gpu-tools)') ? 'intel' : script.includes('IPRIOR') ? 'intel-remove'
        : script.includes('--web.listen-address') ? 'node-exporter' : 'node-exporter-remove'
      ran.push(kind + (script.includes('--collector.textfile.directory=/var/lib/prometheus/node-exporter') ? '+textfile' : ''))
      return { code: 0, output: `HPX-RESULT\t${answer(kind)}` }
    },
    metrics: async () => metrics, writeTargets: () => {}, reload: async () => {}, up: async () => ({ pve: 1 }), sleep: async () => {},
  }
  return d
}

test('preview and apply: the Intel step follows node_exporter, is recorded as measured, and read back', async () => {
  const store = await remoteWith()
  const ran: string[] = []
  const d = deps(SCAN_OUT('intel=yes\nintel_driver=i915\npython3=yes\nintel_gpu_top=no\nintel_ours=no'), k => k === 'intel' ? 'done\tIntel GPU figures measured (1 GPU), served by node_exporter on 10.0.0.7:9100; no new port' : 'done\tlistening on 10.0.0.7:9100 only', ran)
  const scan = await scanMonitoring('c0123456789', d)
  const q = scan.questions.find(x => x.id === 'intel-gpu')!
  assert.equal(q.available, true)
  assert.match(q.what, /intel-gpu-tools.*No new port.*share system memory/)
  const prev = await previewMonitoring('c0123456789', 'owner@example.com', 'install', { 'server-metrics': true, 'intel-gpu': true }, d)
  assert.equal(prev.steps.length, 2)
  assert.match(prev.steps[0], /reading its textfile folder/)
  assert.match(prev.steps[1], /Intel GPU figures: install intel-gpu-tools \(only that package/)
  const r = await applyMonitoring(prev.planId, 'owner@example.com', d)
  assert.deepEqual(ran, ['node-exporter+textfile', 'intel'])
  assert.equal(r.ok, true)
  assert.ok(r.checks.some(c => /reads the Intel GPU figures/.test(c.words) && c.ok))
  assert.equal((await store.list())[0].monitoring.pve.intelGpu?.status, 'measured')
  setClusterStore(new MemoryClusterStore())
})

test('apply: "not supported on this GPU" is recorded as such; a failed node_exporter step skips the Intel step', async () => {
  let store = await remoteWith()
  let ran: string[] = []
  const scan = SCAN_OUT('intel=yes\nintel_driver=xe\npython3=yes\nintel_gpu_top=yes\nintel_ours=no')
  let d = deps(scan, k => k === 'intel' ? 'skipped\tnot supported on this GPU: intel_gpu_top does not support this GPU or its driver (driver xe); nothing was left installed' : 'done\tlistening on 10.0.0.7:9100 only', ran)
  let prev = await previewMonitoring('c0123456789', 'owner@example.com', 'install', { 'server-metrics': true, 'intel-gpu': true }, d)
  await applyMonitoring(prev.planId, 'owner@example.com', d)
  assert.equal((await store.list())[0].monitoring.pve.intelGpu?.status, 'unsupported')

  store = await remoteWith(); ran = []
  d = deps(scan, k => k === 'intel' ? 'done\tIntel GPU figures measured (1 GPU)' : 'failed\tnothing answers on 10.0.0.7:9100', ran)
  prev = await previewMonitoring('c0123456789', 'owner@example.com', 'install', { 'server-metrics': true, 'intel-gpu': true }, d)
  const r = await applyMonitoring(prev.planId, 'owner@example.com', d)
  assert.deepEqual(ran, ['node-exporter+textfile'], 'the Intel step was not sent')
  assert.ok(r.results.some(x => x.status === 'skipped' && /node_exporter did not install/.test(x.reason)))
  setClusterStore(new MemoryClusterStore())
})

test('remove: the Intel collector is taken away before node_exporter', async () => {
  const store = await remoteWith({ pve: { nodeExporter: { listen: '10.0.0.7', installedByHyperProx: true, at: 'x' }, intelGpu: { at: 'x', status: 'measured' } } })
  const ran: string[] = []
  const d = deps(SCAN_OUT('intel=yes\nintel_driver=i915\npython3=yes\nintel_gpu_top=yes\nintel_ours=yes').replace('ours=no', 'ours=yes'), () => 'done\tremoved', ran)
  const prev = await previewMonitoring('c0123456789', 'owner@example.com', 'remove', {}, d)
  assert.match(prev.steps[0], /remove the Intel GPU collector/)
  await applyMonitoring(prev.planId, 'owner@example.com', d)
  assert.deepEqual(ran, ['intel-remove', 'node-exporter-remove'])
  assert.deepEqual((await store.list())[0].monitoring, {})
  setClusterStore(new MemoryClusterStore())
})
