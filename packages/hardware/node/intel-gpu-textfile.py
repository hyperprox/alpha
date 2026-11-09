#!/usr/bin/env python3
# HyperProx Intel GPU collector for node_exporter's textfile folder.
#
# Runs as root under systemd (hyperprox-intel-gpu-textfile.service): intel_gpu_top reads the kernel's i915 perf
# counters, which need root (or CAP_PERFMON). kernel.perf_event_paranoid is never changed: only this service
# reads them. No port is opened: the figures are written to one file in node_exporter's textfile folder, and
# node_exporter serves them on the address it already listens on.
#
# One intel_gpu_top per Intel GPU (every /sys/class/drm/cardN whose vendor is 0x8086), each streaming a JSON
# sample every few seconds. The file is rewritten atomically after every sample. Metric names match the
# intel-gpu-exporter HyperProx already uses at home (igpu_engines_render_3d_0_busy, igpu_power_gpu, ...), with
# two extra labels, pci and card, so several Intel GPUs on one node stay apart.
#
# hyperprox_intel_gpu_info{pci,card,driver,status,reason} 1 says, per GPU, whether figures are flowing:
#   ok              figures measured just now
#   unsupported     intel_gpu_top does not support this GPU or driver (for example an older tool on the xe driver)
#   no_tool         intel_gpu_top is not installed
#   no_permission   the perf counters could not be opened
#   error           anything else (the reason says what)
#
#   intel-gpu-textfile.py [--dir DIR] [--interval SECONDS] [--once] [--tool PATH]
#   intel-gpu-textfile.py --parse FILE     print the metrics one saved intel_gpu_top -J output would give (tests)
#
# HPX_SYSROOT prefixes /sys and /dev, for the tests. Standard library only.
import json, os, re, signal, subprocess, sys, threading, time

ROOT = os.environ.get('HPX_SYSROOT', '')
FILE_NAME = 'hyperprox_intel_gpu.prom'


# ── Parsing intel_gpu_top -J ────────────────────────────────────────────────────────────────────────────────

def engine_name(s):
    """'Render/3D/0' -> 'render_3d_0', 'VideoEnhance' -> 'video_enhance_0' (the exporter's own names)."""
    s = re.sub(r'([a-z])([A-Z])', r'\1_\2', str(s)).lower()
    s = re.sub(r'[^a-z0-9]+', '_', s).strip('_')
    if not s:
        return ''
    return s if re.search(r'_\d+$', s) else s + '_0'


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float('inf'), float('-inf')) else None


def flatten(sample):
    """One intel_gpu_top JSON sample -> {metric name: value}. Unknown or malformed parts are skipped."""
    out = {}
    if not isinstance(sample, dict):
        return out

    def put(k, v):
        n = num(v)
        if n is not None:
            out[k] = n

    def sub(key):
        v = sample.get(key)
        return v if isinstance(v, dict) else {}

    put('igpu_period', sub('period').get('duration'))
    f = sub('frequency')
    put('igpu_frequency_requested', f.get('requested'))
    put('igpu_frequency_actual', f.get('actual'))
    put('igpu_interrupts', sub('interrupts').get('count'))
    put('igpu_rc6', sub('rc6').get('value'))
    p = sub('power')
    # Newer tools: {"GPU": w, "Package": w}; the oldest JSON had a single {"value": w} for the GPU.
    put('igpu_power_gpu', p.get('GPU', p.get('gpu', p.get('value'))))
    put('igpu_power_package', p.get('Package', p.get('package')))
    b = sub('imc-bandwidth')
    put('igpu_imc_bandwidth_reads', b.get('reads'))
    put('igpu_imc_bandwidth_writes', b.get('writes'))
    engines = sample.get('engines')
    if isinstance(engines, dict):
        for eng, vals in engines.items():
            n = engine_name(eng)
            if not n or not isinstance(vals, dict):
                continue
            for k in ('busy', 'sema', 'wait'):
                put('igpu_engines_%s_%s' % (n, k), vals.get(k))
    return out


class JsonStream:
    """Splits intel_gpu_top's stream into whole JSON objects. Old tools print '{...},{...}' with no brackets;
    newer ones wrap the lot in '[ ... ]'. Braces inside strings (a client's process name) are not counted."""

    def __init__(self):
        self.buf, self.depth, self.in_str, self.esc = [], 0, False, False

    def feed(self, text):
        objs = []
        for ch in text:
            if self.depth == 0:
                if ch == '{':
                    self.depth, self.buf, self.in_str, self.esc = 1, ['{'], False, False
                continue
            self.buf.append(ch)
            if self.in_str:
                if self.esc:
                    self.esc = False
                elif ch == '\\':
                    self.esc = True
                elif ch == '"':
                    self.in_str = False
                continue
            if ch == '"':
                self.in_str = True
            elif ch == '{':
                self.depth += 1
            elif ch == '}':
                self.depth -= 1
                if self.depth == 0:
                    try:
                        objs.append(json.loads(''.join(self.buf)))
                    except ValueError:
                        pass
                    self.buf = []
        return objs


def why_not(text):
    """intel_gpu_top's own complaint, in a status and a short reason."""
    t = (text or '').strip()
    low = t.lower()
    if re.search(r'permission denied|operation not permitted|eacces|eperm|perf_event_paranoid|cap_perfmon', low):
        return 'no_permission', 'the GPU perf counters could not be opened (intel_gpu_top must run as root)'
    if re.search(r'no device filter specified and no|no .*devices? found|device not found|not supported|unsupported|'
                 r'failed to (detect|initialize) engines|no gpu devices|xe driver|requested device', low):
        return 'unsupported', 'intel_gpu_top does not support this GPU or its driver'
    last = t.splitlines()[-1] if t else ''
    return 'error', (re.sub(r'\s+', ' ', last)[:160] or 'intel_gpu_top stopped without a sample')


# ── The GPUs on this node ───────────────────────────────────────────────────────────────────────────────────

def intel_cards():
    """[(card, pci, driver)] for every Intel DRM card, by card number."""
    base = ROOT + '/sys/class/drm'
    out = []
    try:
        names = os.listdir(base)
    except OSError:
        return out
    for n in sorted((x for x in names if re.fullmatch(r'card\d+', x)), key=lambda x: int(x[4:])):
        dev = os.path.join(base, n, 'device')
        try:
            with open(os.path.join(dev, 'vendor')) as fh:
                if fh.read().strip().lower() != '0x8086':
                    continue
        except OSError:
            continue
        pci = os.path.basename(os.path.realpath(dev))
        if not re.fullmatch(r'[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]', pci):
            pci = ''
        drv = os.path.basename(os.path.realpath(os.path.join(dev, 'driver'))) if os.path.exists(os.path.join(dev, 'driver')) else ''
        out.append((n, pci, drv if re.fullmatch(r'[\w-]{1,32}', drv or '') else ''))
    return out


# ── The file ────────────────────────────────────────────────────────────────────────────────────────────────

HELP = {
    'hyperprox_intel_gpu_info': 'Intel GPU collector state per GPU (status label), from HyperProx.',
    'hyperprox_intel_gpu_sample_timestamp_seconds': 'When the last intel_gpu_top sample for this GPU was taken.',
}


def esc(v):
    return str(v).replace('\\', '\\\\').replace('"', '\\"').replace('\n', ' ')


def render(gpus):
    """gpus: [{card, pci, driver, status, reason, values, at}] -> Prometheus text format, families together."""
    fams = {}
    for g in gpus:
        lab = 'pci="%s",card="%s"' % (esc(g['pci']), esc(g['card']))
        fams.setdefault('hyperprox_intel_gpu_info', []).append(
            '{%s,driver="%s",status="%s",reason="%s"} 1' % (lab, esc(g['driver']), esc(g['status']), esc(g['reason'])))
        if g['status'] == 'ok':
            fams.setdefault('hyperprox_intel_gpu_sample_timestamp_seconds', []).append('{%s} %.3f' % (lab, g['at']))
            for k, v in g['values'].items():
                fams.setdefault(k, []).append('{%s} %s' % (lab, repr(float(v))))
    lines = []
    for name in sorted(fams):
        lines.append('# HELP %s %s' % (name, HELP.get(name, 'From intel_gpu_top, via HyperProx.')))
        lines.append('# TYPE %s gauge' % name)
        lines.extend(name + row for row in fams[name])
    return '\n'.join(lines) + '\n'


def write_atomic(directory, text):
    path = os.path.join(directory, FILE_NAME)
    tmp = path + '.tmp'
    with open(tmp, 'w') as fh:
        fh.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


# ── Running ─────────────────────────────────────────────────────────────────────────────────────────────────

def find_tool(explicit):
    if explicit:
        return explicit if os.access(explicit, os.X_OK) else None
    for d in os.environ.get('PATH', '/usr/sbin:/usr/bin:/sbin:/bin').split(':') + ['/usr/bin', '/usr/sbin']:
        p = os.path.join(d, 'intel_gpu_top')
        if os.access(p, os.X_OK):
            return p
    return None


def watch(g, tool, interval_ms, lock, changed, once):
    """Stream one GPU's samples into g. A tool that had been working and stopped is started again after a
    pause; one that never gave a sample is not (its reason will not change by itself)."""
    while watch_once(g, tool, interval_ms, lock, changed, once) and not once:
        time.sleep(5)


def watch_once(g, tool, interval_ms, lock, changed, once):
    """One run of intel_gpu_top for this GPU. True when it gave at least one sample before it stopped."""
    dev = '%s/dev/dri/%s' % (ROOT, g['card'])
    try:
        proc = subprocess.Popen([tool, '-J', '-s', str(interval_ms), '-d', 'drm:' + dev],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except OSError as e:
        with lock:
            g['status'], g['reason'] = 'error', 'intel_gpu_top would not start: %s' % e.strerror
        changed.set()
        return False
    err = []
    t = threading.Thread(target=lambda: err.extend(proc.stderr.read().splitlines()[-20:]), daemon=True)
    t.start()
    stream, got = JsonStream(), False
    for chunk in iter(lambda: proc.stdout.readline(), ''):
        for obj in stream.feed(chunk):
            values = flatten(obj)
            if not any(k.startswith('igpu_engines_') for k in values):
                continue
            got = True
            with lock:
                g['status'], g['reason'], g['values'], g['at'] = 'ok', '', values, time.time()
            changed.set()
            if once:
                proc.kill()
                break
        if once and got:
            break
    proc.wait()
    t.join(timeout=2)
    if not got:
        status, reason = why_not('\n'.join(err))
        with lock:
            g['status'], g['reason'] = status, reason
    elif not once:
        with lock:
            g['status'], g['reason'], g['values'] = 'error', 'intel_gpu_top stopped; starting it again', {}
    changed.set()
    return got


def main(argv):
    if '--parse' in argv:
        with open(argv[argv.index('--parse') + 1]) as fh:
            objs = JsonStream().feed(fh.read())
        good = [flatten(o) for o in objs]
        good = [v for v in good if any(k.startswith('igpu_engines_') for k in v)]
        g = {'card': 'card0', 'pci': '0000:00:02.0', 'driver': 'i915', 'at': 0.0,
             'status': 'ok' if good else 'error', 'reason': '' if good else 'no sample in the output',
             'values': good[-1] if good else {}}
        sys.stdout.write(render([g]))
        return 0
    opt = lambda k, d: argv[argv.index(k) + 1] if k in argv else d
    directory = opt('--dir', '/var/lib/prometheus/node-exporter')
    interval_ms = max(1000, int(float(opt('--interval', '5')) * 1000))
    once = '--once' in argv
    tool = find_tool(opt('--tool', None))
    gpus = [{'card': c, 'pci': p, 'driver': d, 'status': 'error', 'reason': 'no sample from intel_gpu_top yet', 'values': {}, 'at': 0.0}
            for c, p, d in intel_cards()]
    os.makedirs(directory, exist_ok=True)
    if not gpus:
        write_atomic(directory, render([]))
        return 0
    if not tool:
        for g in gpus:
            g['status'], g['reason'] = 'no_tool', 'intel_gpu_top is not installed (package intel-gpu-tools)'
        write_atomic(directory, render(gpus))
        return 3
    lock, changed = threading.Lock(), threading.Event()

    def stopped(*_):
        # systemctl stop: leave no figures behind that look current.
        with lock:
            for g in gpus:
                g['status'], g['reason'] = 'error', 'the collector is stopped'
            write_atomic(directory, render(gpus))
        os._exit(0)
    if not once:
        signal.signal(signal.SIGTERM, stopped)

    threads = [threading.Thread(target=watch, args=(g, tool, interval_ms, lock, changed, once), daemon=True) for g in gpus]
    for t in threads:
        t.start()
    while any(t.is_alive() for t in threads):
        changed.wait(timeout=interval_ms / 1000.0 * 3)
        changed.clear()
        with lock:
            write_atomic(directory, render(gpus))
    with lock:
        write_atomic(directory, render(gpus))
    if once:
        return 0 if any(g['status'] == 'ok' for g in gpus) else 3
    # Every GPU's tool has stopped. "Not supported", "no permission" and "no tool" will not fix themselves, so
    # exit 3 (the unit does not restart on 3) and leave the file saying why; anything else, exit 1 and let
    # systemd restart the service after RestartSec.
    return 3 if all(g['status'] in ('unsupported', 'no_permission', 'no_tool') for g in gpus) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
