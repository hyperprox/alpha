'use client'

// =============================================================================
//  HyperProx — Catalogue settings: the container ID rule
//
//  Many homelabs number a container after its address. With the pattern rule
//  on, the install wizard fills in the ID from the node and the IP (and the
//  other way round). The default is simply the next free ID.
// =============================================================================

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { apiJson } from '@/lib/api'
import { Notice } from '@/components/vault/ui'
import { Page, HudHeader, Panel, Pill, styles } from '@/components/visual/kit'
import { alpha } from '@/lib/theme'

type Rule = { kind: 'next-free' } | { kind: 'pattern'; pattern: string }

/** The same rule the server applies, for the live example only; the server decides. */
function example(pattern: string, node: string, ip: string): string {
  const digit = /(\d+)$/.exec(node)?.[1]
  const last = (ip.split('.')[3] ?? '').padStart(3, '0')
  if (!/^\d{3}$/.test(last)) return '—'
  return pattern.replace('{node_digit}', digit ?? '?').replace('{ip_last2}', last.slice(-2)).replace('{ip_last3}', last)
}

export default function CatalogueSettings() {
  const [rule, setRule] = useState<Rule>({ kind: 'next-free' })
  const [pattern, setPattern] = useState('{node_digit}{ip_last2}')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)

  useEffect(() => {
    void apiJson<{ data: { vmidRule: Rule } }>('/api/catalogue/wizard/settings').then(r => {
      if (r.ok && r.body?.data) {
        setRule(r.body.data.vmidRule)
        if (r.body.data.vmidRule.kind === 'pattern') setPattern(r.body.data.vmidRule.pattern)
      } else setMsg({ kind: 'error', text: r.error ?? 'Could not read the setting.' })
      setLoaded(true)
    })
  }, [])

  const save = async () => {
    setSaving(true); setMsg(null)
    const vmidRule: Rule = rule.kind === 'pattern' ? { kind: 'pattern', pattern } : { kind: 'next-free' }
    const r = await apiJson<{ data: { vmidRule: Rule } }>('/api/catalogue/wizard/settings', 'PUT', { vmidRule })
    setSaving(false)
    if (!r.ok) return setMsg({ kind: 'error', text: r.error ?? 'Could not save.' })
    setRule(r.body!.data.vmidRule)
    setMsg({ kind: 'info', text: 'Saved. The install wizard uses it from the next install.' })
  }

  const option = (kind: Rule['kind'], title: string, body: string) => (
    <label className="flex gap-3 cursor-pointer"
      style={{ borderRadius: 12, padding: 14, border: `1px solid ${rule.kind === kind ? 'var(--accent)' : 'var(--border-soft)'}`,
               background: rule.kind === kind ? alpha('var(--accent)', 8) : 'var(--ground-deep)' }}>
      <input type="radio" name="rule" checked={rule.kind === kind}
        onChange={() => setRule(kind === 'pattern' ? { kind, pattern } : { kind })} className="mt-1" />
      <span>
        <span className="block font-display text-[18px] font-semibold" style={{ color: 'var(--text-bright)' }}>{title}</span>
        <span className="block text-sm" style={{ color: 'var(--text-muted)' }}>{body}</span>
      </span>
    </label>
  )

  return (
    <Page>
      <HudHeader level={2} eyebrow="Catalogue" icon="plugin" label="Container ID rule"
        title={rule.kind === 'pattern' ? 'IDs follow a pattern' : 'IDs use the next free number'}
        chips={[{ label: 'Rule', value: rule.kind === 'pattern' ? 'Pattern' : 'Next free', tone: 'accent' }]}
        actions={<Link href="/catalogue" className={styles.btn} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>← Catalogue</Link>}>
        <p style={{ margin: 0, maxWidth: 680, fontSize: 15, lineHeight: 1.6, color: 'var(--text-soft)' }}>
          The ID and address rules now live in <Link href="/settings/naming" style={{ color: 'var(--accent)' }}>Settings → Naming &amp; addresses</Link>;
          once those are saved they win, and this older pattern is only used to fill the other half of an ID you type.
          How the install wizard suggests a container ID. You can always type a different one; it is checked against
          every container and VM before anything is created.
        </p>
      </HudHeader>
      {!loaded ? <p className={styles.empty}>loading…</p> : (
        <div className="space-y-3 w-full" style={{ maxWidth: 760 }}>
          <Panel title="Rule" sub="how the wizard picks an ID" actions={<Pill tone="accent">{rule.kind === 'pattern' ? 'pattern' : 'next free'}</Pill>}>
            <div className="space-y-3">
              {option('next-free', 'Next free', 'The lowest ID no container or VM has. The default.')}
              {option('pattern', 'Pattern', 'Build the ID from the node and the address. Picking the IP and node fills in the ID, and typing an ID fills in the node and IP.')}
            </div>
          </Panel>
          {rule.kind === 'pattern' && (
            <Panel title="Pattern">
              <label className={styles.field}>
                <span>Pattern</span>
                <input value={pattern} onChange={e => setPattern(e.target.value.trim())} className={styles.input} style={{ fontFamily: 'var(--font-mono)' }}
                  autoCapitalize="none" spellCheck={false} />
              </label>
              <ul className="text-[13px] space-y-0.5" style={{ color: 'var(--text-muted)', margin: '12px 0', padding: 0, listStyle: 'none' }}>
                <li><code className="font-mono" style={{ color: 'var(--accent)' }}>{'{node_digit}'}</code> the number at the end of the node name (node-3 → 3)</li>
                <li><code className="font-mono" style={{ color: 'var(--accent)' }}>{'{ip_last2}'}</code> the last two digits of the address (….242 → 42, ….5 → 05)</li>
                <li><code className="font-mono" style={{ color: 'var(--accent)' }}>{'{ip_last3}'}</code> the whole last number, three digits (….5 → 005)</li>
                <li>Anything else must be digits.</li>
              </ul>
              <p className="text-[13px]" style={{ color: 'var(--text-dim)', margin: 0 }}>
                Example: node-7 and 192.0.2.242 give <span className="font-mono" style={{ color: 'var(--text-bright)' }}>{example(pattern, 'node-7', '192.0.2.242')}</span>.
                If the ID it gives is taken, the wizard says so.
              </p>
            </Panel>
          )}
          <Panel title="What the address check can and can't prove">
            <p className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>
              When you pick a fixed IP, the wizard refuses it if it finds any of these:
            </p>
            <ul className="text-[13px] space-y-0.5 mb-2" style={{ color: 'var(--text-muted)', padding: 0, listStyle: 'none' }}>
              <li>· the address is written in a container or VM config in this cluster;</li>
              <li>· a running container reports it, or a running VM reports it through its guest agent;</li>
              <li>· it is the address of one of the nodes;</li>
              <li>· something answers a ping to it, sent from the node you chose.</li>
            </ul>
            <p className="text-sm" style={{ color: 'var(--text-muted)', margin: 0 }}>
              It cannot prove the address is free. A device outside the cluster that blocks ping, a machine that is
              switched off, a VM without a guest agent, or an address your router has handed out by DHCP will not be
              seen. Keep fixed addresses out of your router&rsquo;s DHCP range. The review screen says which checks ran,
              and when ping could not be sent.
            </p>
          </Panel>
          {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
          <button onClick={() => void save()} disabled={saving} className={`${styles.btn} ${styles.btnPri}`}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </Page>
  )
}
