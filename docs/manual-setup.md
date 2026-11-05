# Doing it by hand

You should not need this page. The installer (`bootstrap.sh` or the setup wizard) asks a few yes/no
questions and does all of this for you, and **Settings → Setup checklist** does anything you skipped,
with one click. This page is for people who want to see exactly what those steps do, or who have to do
one on a node HyperProx cannot sign in to.

The scripts HyperProx runs are in [`packages/hardware/node/`](../packages/hardware/node). They only add
packages (apt is asked first, and an install that would upgrade or remove anything is refused), never
touch kernels, drivers or apt holds, and leave alone anything that is already set up.

<details>
<summary>Watch node health (node_exporter)</summary>

On each node:

```bash
apt-get update && apt-get install --no-install-recommends prometheus-node-exporter
systemctl enable --now prometheus-node-exporter
curl -s http://localhost:9100/metrics | head -5
```

It answers on port 9100. HyperProx adds the node to Prometheus by itself.
</details>

<details>
<summary>Monitor power (the RAPL rule)</summary>

Since kernel 5.10 the CPU energy counters are readable by root only, so node_exporter gets nothing. On
each node, create `/etc/udev/rules.d/99-hyperprox-rapl.rules` containing:

```
SUBSYSTEM=="powercap", ACTION=="add|change", RUN+="/bin/chmod o+r /sys%p/energy_uj"
```

Then `udevadm control --reload-rules && udevadm trigger --action=add --subsystem-match=powercap`.
`stat -c %a /sys/class/powercap/intel-rapl:0/energy_uj` should print `404`. The trade-off: any local
user on that node can then read energy use. Delete the file to undo it.
</details>

<details>
<summary>Monitor an Intel GPU (built in or Arc)</summary>

If the node already runs Docker:

```bash
docker run -d --name intel-gpu-exporter --restart unless-stopped \
  --privileged --pid host -v /dev/dri:/dev/dri -p 8081:8080 \
  ghcr.io/onedr0p/intel-gpu-exporter:rolling@sha256:90a95483bf5d3752f4db2ab2e1663f19bba307fd832bf53557cbdc38c3701f84
```

Without Docker, HyperProx installs `intel-gpu-tools` and runs its own small exporter (the Python script
inside [`intel-gpu-exporter.sh`](../packages/hardware/node/intel-gpu-exporter.sh)) as the
`hyperprox-intel-gpu-exporter` service. Both answer on port 8081 with the same metric names. HyperProx
does not install Docker on a Proxmox node, because Docker changes the firewall your guests' networking
goes through.
</details>

<details>
<summary>Monitor an NVIDIA GPU</summary>

The NVIDIA driver must already be installed (`nvidia-smi` works). HyperProx never installs or changes
drivers. It downloads [nvidia_gpu_exporter](https://github.com/utkuozdemir/nvidia_gpu_exporter) 1.15.1,
checks it against its published checksum, and runs it as the `hyperprox-nvidia-gpu-exporter` service
on port 9835. The unit it writes is in
[`nvidia-gpu-exporter.sh`](../packages/hardware/node/nvidia-gpu-exporter.sh).

AMD GPUs are listed but not monitored yet.
</details>

<details>
<summary>Let containers use a node's built-in graphics</summary>

On a node with built-in Intel or AMD graphics, create `/etc/udev/rules.d/99-hyperprox-igpu.rules`
containing:

```
SUBSYSTEM=="drm", KERNEL=="renderD*", MODE="0666"
```

Then `udevadm control --reload && udevadm trigger --subsystem-match=drm`. `stat -c %a /dev/dri/renderD128`
should print `666`. The trade-off: any container on that node can then use its built-in graphics. To undo
it, delete the file and run the trigger again.
</details>

<details>
<summary>The metrics list (Prometheus targets)</summary>

HyperProx writes `config/prometheus/targets/*.json` itself: when setup finishes, whenever a node joins
(it checks every few minutes while unlocked), and when you press **Check now** on the Setup checklist.
It only adds entries, so one you edited is kept. As an admin you can also call `POST /api/targets/sync`.
</details>

<details>
<summary>Proxmox's own metrics (the PVE exporter token)</summary>

`hyperprox pve-exporter` on the HyperProx machine (HyperProx must be unlocked) makes a read-only token
(`PVEAuditor` on `/`, privilege separation on) and restarts the exporter. `--fresh` replaces a token that
is not read-only.
</details>

<details>
<summary>GoDaddy key</summary>

1. Go to [developer.godaddy.com/keys](https://developer.godaddy.com/keys) and create a key.
2. Choose **Production**. Test (OTE) keys do not work.
3. Paste the key and secret on the Setup checklist, or under **Settings → DNS → GoDaddy**. HyperProx
   tests it and keeps it in the vault.
</details>

<details>
<summary>The bundled local AI (Ollama)</summary>

```bash
cd /opt/hyperprox
docker compose --profile ai up -d --no-deps ollama
docker exec hyperprox-ollama ollama pull llama3.2:3b
```

Then connect `http://127.0.0.1:11434` on the AI Assistant page, and add `ai` to `COMPOSE_PROFILES` in
`.env` so it starts again after a reboot.
</details>
