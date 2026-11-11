'use client'

// =============================================================================
//  HyperProx — Sites
//
//  The websites the catalogue made, with what a site owner reaches for: open
//  it, sign in to its admin, see its password, pull it again, check it. The
//  admin sign-in is a one-time link the server makes (60 seconds, once), sent
//  by POST from a window opened on the click, so it never sits in a URL.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { apiJson } from '@/lib/api'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { Page, HudHeader, Panel, Pill, Tiles, styles } from '@/components/visual/kit'
import { NewSiteWizard, type SiteRecipe } from '@/components/sites/NewSiteWizard'

interface Site {
  id: string; recipeId: string; name: string; vmid: number; node: string; ip: string | null
  domain: string | null; url: string | null; localUrl: string | null; adminUser: string | null
  vaultItem: string | null; adminUrl: string | null; createdAt: number
}
type Pending = { kind: 'login' | 'reveal'; site: Site } | null

export default function SitesPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [recipes, setRecipes] = useState<SiteRecipe[]>([])
  const [loading, setLoading] = useState(true)
  const [wizard, setWizard] = useState(false)
  // /sites?preview=<id>: a plan the AI assistant made with the wizard's own code, opened at its review step.
  const [previewId, setPreviewId] = useState<string | null>(null)
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('preview')
    if (id && /^[A-Za-z0-9-]{8,64}$/.test(id)) { setPreviewId(id); setWizard(true) }
  }, [])
  const [note, setNote] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, Record<string, string>>>({})
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([apiJson<{ data: { sites: Site[] } }>('/api/sites'), apiJson<{ data: { recipes: SiteRecipe[] } }>('/api/catalogue')])
    if (s.ok && s.body) setSites(s.body.data.sites)
    if (c.ok && c.body) setRecipes(c.body.data.recipes.filter(r => r.category === 'web'))
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  const say = (id: string, text: string) => setNote(n => ({ ...n, [id]: text }))

  const health = async (s: Site) => {
    setBusy(s.id + 'h')
    const r = await apiJson<{ data: { checks: Array<{ url: string; ok: boolean; detail: string }> } }>(`/api/sites/${s.id}/health`)
    setBusy('')
    say(s.id, r.ok ? r.body!.data.checks.map(c => `${c.ok ? '✓' : '✕'} ${c.url} ${c.detail}`).join('  ') : r.error ?? 'Could not check.')
  }
  const pull = async (s: Site) => {
    setBusy(s.id + 'p')
    const r = await apiJson<{ data: { output: string } }>(`/api/sites/${s.id}/pull`, 'POST')
    setBusy('')
    say(s.id, r.ok ? r.body!.data.output : r.error ?? 'The pull failed.')
  }

  // The window opens on the click itself, so the browser does not block it; the sign-in is POSTed into it.
  const openAdmin = async (s: Site, win: Window | null = window.open('', '_blank')) => {
    const r = await apiJson<{ data: { postUrl: string; token: string } }>(`/api/sites/${s.id}/admin-login`, 'POST')
    if (r.status === 403 && r.code === 'reconfirm_required') { win?.close(); setPending({ kind: 'login', site: s }); return }
    if (!r.ok || !r.body) { win?.close(); say(s.id, r.error ?? 'The sign-in could not be made.'); return }
    if (!win) { say(s.id, 'The browser blocked the new window. Allow pop-ups for HyperProx and try again.'); return }
    const d = win.document
    const form = d.createElement('form')
    form.method = 'POST'; form.action = r.body.data.postUrl
    const input = d.createElement('input')
    input.type = 'hidden'; input.name = 'token'; input.value = r.body.data.token
    form.appendChild(input); d.body.appendChild(form); form.submit()
    say(s.id, 'Signed in to WordPress in a new tab. That link has now been used.')
  }

  const reveal = async (s: Site) => {
    if (!s.vaultItem) return
    const r = await apiJson<{ data: { fields: Record<string, string> } }>('/api/secrets/reveal', 'POST', { name: s.vaultItem })
    if (r.status === 403 && r.code === 'reconfirm_required') { setPending({ kind: 'reveal', site: s }); return }
    if (!r.ok || !r.body) { say(s.id, r.error ?? 'The vault could not reveal it.'); return }
    setRevealed(v => ({ ...v, [s.id]: r.body!.data.fields }))
  }

  if (loading) return <Page><p className={styles.empty}>loading sites…</p></Page>

  return (
    <Page>
      <HudHeader level={1} eyebrow="Web" title="Sites" icon="home" label="Sites overview"
        chips={[{ label: 'sites', value: sites.length }, { label: 'published', value: sites.filter(s => s.url).length }]}
        actions={<div className={styles.row} style={{ gap: 8 }}>
          <Link href="/catalogue" className={styles.btn} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Catalogue</Link>
          <button type="button" className={`${styles.btn} ${styles.btnPri}`} onClick={() => setWizard(true)} disabled={!recipes.length}>New website</button>
        </div>} />

      {sites.length === 0 && (
        <Panel title="No websites yet" sub="one flow from nothing to a live site">
          <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)' }}>
            New website picks the kind, the public name, the node and the basics, shows the whole plan, then makes the container,
            the DNS record, the proxy host and the certificate, and checks the public address answers.
          </p>
        </Panel>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(min(360px,100%),1fr))' }}>
        {sites.map(s => {
          const r = recipes.find(x => x.id === s.recipeId)
          const shown = revealed[s.id]
          return (
            <div key={s.id} className={styles.card} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className={styles.row} style={{ flexWrap: 'wrap' }}>
                <h2 className="font-display" style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--text-bright)' }}>{s.name}</h2>
                <span className={styles.tag}>{r?.name ?? s.recipeId}</span>
                <span style={{ marginLeft: 'auto' }}><Pill tone={s.url ? 'good' : 'accent'}>{s.url ? 'published' : 'local only'}</Pill></span>
              </div>
              <Tiles label={`${s.name} facts`} items={[{ label: 'CT', value: s.vmid }, { label: 'node', value: s.node }, { label: 'address', value: s.ip ?? '—' }]} />
              <div className={styles.row} style={{ flexWrap: 'wrap', gap: 8 }}>
                {(s.url ?? s.localUrl) && <a className={`${styles.btn} ${styles.btnPri}`} href={s.url ?? s.localUrl!} target="_blank" rel="noreferrer">Open site</a>}
                {s.recipeId === 'wordpress' && <button type="button" className={styles.btn} onClick={() => void openAdmin(s)}>Open WordPress admin</button>}
                {s.vaultItem && <button type="button" className={styles.btn} onClick={() => void reveal(s)}>Reveal password</button>}
                {s.recipeId === 'static-site' && <button type="button" className={styles.btn} disabled={busy === s.id + 'p'} onClick={() => void pull(s)}>{busy === s.id + 'p' ? 'Pulling…' : 'Pull now'}</button>}
                <button type="button" className={styles.btn} disabled={busy === s.id + 'h'} onClick={() => void health(s)}>{busy === s.id + 'h' ? 'Checking…' : 'Health'}</button>
              </div>
              {shown && (
                <div className={styles.callout}>
                  {Object.entries(shown).filter(([k]) => /^(admin_user|admin_password|db_password)$/.test(k)).map(([k, v]) => (
                    <div key={k} className={styles.row} style={{ gap: 8 }}>
                      <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 110 }}>{k.replace('_', ' ')}</span>
                      <code className="select-all font-mono" style={{ fontSize: 12, color: 'var(--text-bright)', overflowWrap: 'anywhere' }}>{v}</code>
                    </div>
                  ))}
                  <button type="button" className={styles.btn} style={{ marginTop: 8 }} onClick={() => setRevealed(v => { const n = { ...v }; delete n[s.id]; return n })}>Hide</button>
                </div>
              )}
              {note[s.id] && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>{note[s.id]}</p>}
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-dim)' }}>
                Not automatic yet: a backup job, monitoring with alerts, a place under the update policy and a plug-in panel.
              </p>
            </div>
          )
        })}
      </div>

      {wizard && <NewSiteWizard recipes={recipes} previewId={previewId} onClose={() => { setWizard(false); setPreviewId(null) }} onDone={() => { setWizard(false); setPreviewId(null); void load() }} />}
      {pending && (
        <ReconfirmModal onClose={() => setPending(null)} onDone={() => {
          const p = pending; setPending(null)
          if (p.kind === 'login') void openAdmin(p.site)
          else void reveal(p.site)
        }} />
      )}
    </Page>
  )
}
