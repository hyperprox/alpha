'use client'

// =============================================================================
//  Settings → Naming & addresses
//
//  Where new guests go on the network and how they are numbered. Every wizard
//  that creates a guest (Catalogue, New website, the Arr Stack, the backup
//  server, the assistant) picks the next free ID and address from here, pings
//  the address from the node first, and asks for a typed confirmation before
//  DHCP under "never" or an address outside the range. Saving needs the
//  master password again; the API enforces it.
// =============================================================================

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { GhostButton, INPUT, LABEL, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Page, Panel, Pill, styles } from '@/components/visual/kit'
import { alpha } from '@/lib/theme'
import type { NamingSettingsView } from '@/components/catalogue/NamingProposal'

interface Saved extends NamingSettingsView { updatedAt?: string; updatedBy?: string }
interface Detection {
  verdict: 'follows' | 'mixed' | 'none'; matching: number; considered: number; total: number
  proposal?: NamingSettingsView
  examples: Array<{ vmid: number; node: string; ip: string }>
  nodes: Array<{ node: string; address: string | null }>
}

interface Form {
  subnet: string; rangeStart: string; rangeEnd: string; gateway: string; dns: string; bridge: string; vlan: string
  idScheme: 'next-free' | 'node-ip'; nodeIndex: Record<string, string>; dhcp: 'never' | 'warn' | 'allowed'
}

const EMPTY: Form = { subnet: '', rangeStart: '', rangeEnd: '', gateway: '', dns: '', bridge: 'vmbr0', vlan: '', idScheme: 'next-free', nodeIndex: {}, dhcp: 'never' }

const toForm = (s: NamingSettingsView): Form => ({
  subnet: s.subnet, rangeStart: s.rangeStart, rangeEnd: s.rangeEnd, gateway: s.gateway, dns: s.dns.join(' '), bridge: s.bridge,
  vlan: s.vlan ? String(s.vlan) : '', idScheme: s.idScheme, dhcp: s.dhcp,
  nodeIndex: Object.fromEntries(Object.entries(s.nodeIndex).map(([k, v]) => [k, String(v)])),
})

/** The trailing number in a node name, as the server reads it. */
const trailing = (n: string) => /(\d+)$/.exec(n)?.[1]

/** "CT 3xx ↔ 192.0.2.2xx": what the scheme does, in one line, for the live example. */
function exampleLine(f: Form, node?: string): string {
  const o = f.rangeStart.split('.')
  if (o.length !== 4) return '—'
  if (f.idScheme !== 'node-ip') return `next free ID · ${f.rangeStart}–${f.rangeEnd.split('.')[3] ?? ''}`
  const hundreds = Math.floor(Number(o[3]) / 100)
  return `CT ${(node && f.nodeIndex[node]) || 'N'}xx ↔ ${o.slice(0, 3).join('.')}.${hundreds || ''}xx`
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span style={LABEL}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px]" style={{ color: 'var(--text-dim)' }}>{hint}</span>}
    </label>
  )
}

function Choice<T extends string>({ name, value, current, onPick, title, body }: { name: string; value: T; current: T; onPick: (v: T) => void; title: string; body: string }) {
  const on = value === current
  return (
    <label className="flex gap-3 cursor-pointer"
      style={{ borderRadius: 12, padding: 14, border: `1px solid ${on ? 'var(--accent)' : 'var(--border-soft)'}`, background: on ? alpha('var(--accent)', 8) : 'var(--ground-deep)' }}>
      <input type="radio" name={name} checked={on} onChange={() => onPick(value)} className="mt-1" />
      <span>
        <span className="block font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>{title}</span>
        <span className="block text-sm" style={{ color: 'var(--text-muted)' }}>{body}</span>
      </span>
    </label>
  )
}

export default function NamingSettingsPage() {
  const [saved, setSaved] = useState<Saved | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [nodes, setNodes] = useState<string[]>([])
  const [detection, setDetection] = useState<Detection | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [reconfirm, setReconfirm] = useState(false)

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }))

  const detect = async (fill: boolean) => {
    setDetecting(true)
    const r = await apiJson<{ data: Detection }>('/api/catalogue/wizard/naming/detect', 'POST')
    setDetecting(false)
    if (!r.ok || !r.body?.data) { setMsg({ kind: 'error', text: r.error ?? 'Could not read the cluster.' }); return }
    const d = r.body.data
    setDetection(d)
    const names = d.nodes.map(n => n.node)
    setNodes(names)
    // Every node gets an index field, filled from a trailing number where the name has one.
    setForm(f => ({ ...f, nodeIndex: Object.fromEntries(names.map(n => [n, f.nodeIndex[n] ?? trailing(n) ?? ''])) }))
    if (fill && d.proposal) {
      setForm(f => ({ ...toForm(d.proposal!), nodeIndex: { ...Object.fromEntries(names.map(n => [n, trailing(n) ?? ''])), ...toForm(d.proposal!).nodeIndex } }))
      setMsg({ kind: 'info', text: 'Filled in from your guests. Check it, then save.' })
    } else if (fill) setMsg({ kind: 'info', text: 'Your guests do not follow node + address numbering, so nothing was filled in.' })
  }

  useEffect(() => {
    void apiJson<{ data: { settings: Saved | null; problem?: string } }>('/api/catalogue/wizard/naming').then(r => {
      if (r.ok && r.body?.data?.settings) { setSaved(r.body.data.settings); setForm(toForm(r.body.data.settings)) }
      if (r.ok && r.body?.data?.problem) setMsg({ kind: 'error', text: `${r.body.data.problem} Until then every wizard refuses to create a guest.` })
      else if (!r.ok) setMsg({ kind: 'error', text: r.error ?? 'Could not read the setting.' })
      setLoaded(true)
      void detect(false)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const body = useMemo(() => ({
    subnet: form.subnet.trim(), rangeStart: form.rangeStart.trim(), rangeEnd: form.rangeEnd.trim(), gateway: form.gateway.trim(),
    dns: form.dns.split(/[\s,]+/).filter(Boolean), bridge: form.bridge.trim(), ...(form.vlan.trim() ? { vlan: Number(form.vlan) } : {}),
    idScheme: form.idScheme, dhcp: form.dhcp,
    nodeIndex: Object.fromEntries(Object.entries(form.nodeIndex).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number(v)])),
  }), [form])

  const save = async () => {
    setSaving(true); setMsg(null); setProblems([])
    const r = await apiJson<{ data: { settings: Saved } }>('/api/catalogue/wizard/naming', 'PUT', { settings: body })
    setSaving(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(true); return }
    if (!r.ok) { setProblems((r.body as any)?.problems ?? []); setMsg({ kind: 'error', text: r.error ?? 'Could not save.' }); return }
    setSaved(r.body!.data.settings); setForm(toForm(r.body!.data.settings))
    setMsg({ kind: 'info', text: 'Saved. Every wizard uses it from the next install.' })
  }

  const firstNode = nodes.find(n => form.nodeIndex[n])
  return (
    <Page>
      <HudHeader level={2} eyebrow="Settings" icon="network" label="Naming and addresses"
        title={saved ? exampleLine(toForm(saved), firstNode) : 'Not set yet'}
        chips={[
          { label: 'IDs', value: (saved ?? form).idScheme === 'node-ip' ? 'Node + address' : 'Next free', tone: 'accent' },
          { label: 'DHCP', value: saved ? { never: 'Never', warn: 'With a warning', allowed: 'Allowed' }[saved.dhcp] : 'Not set', tone: saved?.dhcp === 'never' ? 'good' : 'warn' },
        ]}
        actions={<Link href="/settings" className={styles.btn} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>← Settings</Link>}>
        <p style={{ margin: 0, maxWidth: 720, fontSize: 15, lineHeight: 1.6, color: 'var(--text-soft)' }}>
          Where new guests go on your network, and how they are numbered. Every wizard picks the next free ID and address
          from here, checks the ID is free everywhere, that no guest config has the address, and that nothing answers it
          from the node. You can still choose something else in a wizard: an address outside the range, or DHCP when it is
          set to never, asks you to type it to confirm, and is written to the audit log.
        </p>
      </HudHeader>

      {!loaded ? <p className={styles.empty}>loading…</p> : (
        <div className="space-y-4 w-full" style={{ maxWidth: 820 }}>
          <Panel title="Auto-detect" sub="Read the numbering your guests already use.">
            <div className="flex flex-wrap items-center gap-3">
              <GhostButton type="button" onClick={() => void detect(true)} disabled={detecting}>{detecting ? 'Reading the cluster…' : 'Fill in from my guests'}</GhostButton>
              {detection && (
                <span className="text-sm" style={{ color: 'var(--text-soft)' }}>
                  <Pill tone={detection.verdict === 'follows' ? 'good' : detection.verdict === 'mixed' ? 'warn' : undefined}>
                    {detection.verdict === 'follows' ? 'follows node + address' : detection.verdict === 'mixed' ? 'mixed' : 'no pattern'}
                  </Pill>{' '}
                  {detection.matching} of {detection.total} guests already follow this
                  {detection.total > detection.considered ? ` (${detection.total - detection.considered} have no fixed address)` : ''}.
                </span>
              )}
            </div>
            {detection?.examples.length ? (
              <p className="mt-2 font-mono text-[12px]" style={{ color: 'var(--text-dim)' }}>
                {detection.examples.map(e => `${e.vmid} on ${e.node} ↔ ${e.ip}`).join(' · ')}
              </p>
            ) : null}
          </Panel>

          <Panel title="Guest network" sub="The network new guests go on and the addresses HyperProx may give them.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Subnet" hint="Network address and prefix.">
                <input value={form.subnet} onChange={e => set('subnet', e.target.value)} placeholder="192.0.2.0/24" style={INPUT} inputMode="decimal" spellCheck={false} />
              </Field>
              <Field label="Gateway">
                <input value={form.gateway} onChange={e => set('gateway', e.target.value)} placeholder="192.0.2.1" style={INPUT} inputMode="decimal" spellCheck={false} />
              </Field>
              <Field label="First address" hint="Keep the range out of your router's DHCP pool.">
                <input value={form.rangeStart} onChange={e => set('rangeStart', e.target.value)} placeholder="192.0.2.200" style={INPUT} inputMode="decimal" spellCheck={false} />
              </Field>
              <Field label="Last address">
                <input value={form.rangeEnd} onChange={e => set('rangeEnd', e.target.value)} placeholder="192.0.2.254" style={INPUT} inputMode="decimal" spellCheck={false} />
              </Field>
              <Field label="DNS servers" hint="Up to three, space-separated. Blank uses the node's.">
                <input value={form.dns} onChange={e => set('dns', e.target.value)} placeholder="192.0.2.53" style={INPUT} inputMode="decimal" spellCheck={false} />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Bridge"><input value={form.bridge} onChange={e => set('bridge', e.target.value)} placeholder="vmbr0" style={INPUT} spellCheck={false} /></Field>
                <Field label="VLAN tag" hint="Optional.">
                  <input type="number" min={1} max={4094} value={form.vlan} onChange={e => set('vlan', e.target.value)} style={INPUT} inputMode="numeric" />
                </Field>
              </div>
            </div>
          </Panel>

          <Panel title="ID scheme" sub="How a new guest's ID is chosen.">
            <div className="space-y-3">
              <Choice name="scheme" value="next-free" current={form.idScheme} onPick={v => set('idScheme', v)}
                title="Free ID (Proxmox next ID)" body="The lowest ID no CT or VM has. The address still comes from the range." />
              <Choice name="scheme" value="node-ip" current={form.idScheme} onPick={v => set('idScheme', v)}
                title="Node + address" body="The ID is the node's index followed by the last two digits of the address: index 3 and .242 give 342. The range must sit inside one block of a hundred, like .200–.254." />
              {form.idScheme === 'node-ip' && (
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
                  <p className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>Node index: filled from the number a node's name ends in. Blank leaves the node out of the scheme; its guests get the next free ID.</p>
                  <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
                    {nodes.map(n => (
                      <Field key={n} label={n} hint={form.nodeIndex[n] && form.rangeStart ? exampleLine(form, n) : undefined}>
                        <input type="number" min={1} max={999} value={form.nodeIndex[n] ?? ''} inputMode="numeric" style={INPUT}
                          onChange={e => setForm(f => ({ ...f, nodeIndex: { ...f.nodeIndex, [n]: e.target.value } }))} />
                      </Field>
                    ))}
                    {!nodes.length && <p className={styles.empty}>reading the nodes…</p>}
                  </div>
                </div>
              )}
            </div>
          </Panel>

          <Panel title="DHCP" sub="Whether a wizard may leave a guest's address to DHCP.">
            <div className="space-y-3">
              <Choice name="dhcp" value="never" current={form.dhcp} onPick={v => set('dhcp', v)}
                title="Never" body="Every guest gets a fixed address from the range. Choosing DHCP in a wizard needs you to type DHCP, and is audited." />
              <Choice name="dhcp" value="warn" current={form.dhcp} onPick={v => set('dhcp', v)}
                title="Allowed with a warning" body="DHCP can be picked; the review says it may land on another network." />
              <Choice name="dhcp" value="allowed" current={form.dhcp} onPick={v => set('dhcp', v)}
                title="Allowed" body="DHCP can be picked without a warning. Only if your bridges carry one network." />
            </div>
          </Panel>

          {problems.length > 0 && <Notice kind="error"><ul className="space-y-0.5">{problems.map((p, i) => <li key={i}>· {p}</li>)}</ul></Notice>}
          {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
              {saved?.updatedAt ? `Saved ${new Date(saved.updatedAt).toLocaleString()}${saved.updatedBy ? ` by ${saved.updatedBy}` : ''}.` : 'Nothing saved yet: wizards use your guests’ numbering if they follow one, else a free address on the node’s network.'}
              {' '}Saving asks for your master password.
            </span>
            <PrimaryButton type="button" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</PrimaryButton>
          </div>
        </div>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(false)} onDone={() => { setReconfirm(false); void save() }} />}
    </Page>
  )
}
