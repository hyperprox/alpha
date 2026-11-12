'use client'

// =============================================================================
//  HyperProx — the transcoders' picker, step 1 of the install wizard
//
//  For Unmanic, Tdarr and their extra worker/node entries. What goes in the
//  container (hardware acceleration, the library, the worker count, the main
//  server a worker joins) is asked here; which node it goes on is step 3, where
//  NodeHardware shows what that node really has. The server checks all of it
//  again, and refuses a hardware choice the node cannot honour.
// =============================================================================

import { useEffect } from 'react'
import { apiJson } from '@/lib/api'
import { alpha } from '@/lib/theme'
import { useState } from 'react'
import { INPUT } from '@/components/vault/ui'
import { Field, MediaSource, Segmented, mediaMissing, type MediaFacts } from './MediaSource'

export type TcKind = 'unmanic' | 'unmanic-worker' | 'tdarr' | 'tdarr-node'
export const TC_KINDS: TcKind[] = ['unmanic', 'unmanic-worker', 'tdarr', 'tdarr-node']
export const isTcRecipe = (r: { id: string; stack?: string | null }) => r.stack === 'transcode' && (TC_KINDS as string[]).includes(r.id)
const hasLibrary = (k: TcKind) => k !== 'unmanic-worker'
const isUnmanic = (k: TcKind) => k.startsWith('unmanic')
const needsMain = (k: TcKind) => k === 'unmanic-worker' || k === 'tdarr-node'

interface Facts extends MediaFacts { unmanicUrl: string | null }
interface HwFacts { vaapi: { names: string[] } | null; nvidia: { names: string[]; driver: string } | null; auto: 'vaapi' | 'nvidia' | 'cpu' }

const ACCEL_WORDS: Record<string, string> = { auto: 'Automatic', vaapi: 'Intel / AMD', nvidia: 'NVIDIA', cpu: 'CPU only' }

const EXPLAIN: Record<TcKind, { what: string; extras: string }> = {
  unmanic: {
    what: 'One container with Unmanic in it. Your library is mounted at /data/media, the folder the Arr Stack fills.',
    extras: 'Want more horsepower? After this install, add Unmanic workers on other nodes. Unmanic calls them remote installations: your main Unmanic sends a file to the worker, the worker converts it on its own GPU, and the result comes back. The files cross the network twice, so on a 1 Gb network the link can be the limit.',
  },
  'unmanic-worker': {
    what: 'An extra Unmanic that takes jobs from your main one. It needs no library of its own: files travel to it and back.',
    extras: 'HyperProx links both sides for you. The main Unmanic is changed once, to add this worker; clean-up of a failed install removes only that link.',
  },
  tdarr: {
    what: 'One container with the Tdarr server and a node beside it. The server hands out jobs; the node, with the GPU, does the work.',
    extras: 'Want more nodes? After this install, add Tdarr nodes on other cluster nodes. Each sees the library at exactly the same path (/data/media) and runs the server\'s own Tdarr version, and each gets its own node\'s hardware.',
  },
  'tdarr-node': {
    what: 'An extra Tdarr node on another cluster node, for the Tdarr server you already run.',
    extras: 'It must see the library at exactly /data/media, the same text the server uses: give it the same NAS export, or a folder that exists on this node at the same place.',
  },
}

/** Everything the server needs from this picker, plus what is still missing. */
export function tcMissing(kind: TcKind, opts: Record<string, string>): string[] {
  const m: string[] = []
  if (hasLibrary(kind)) m.push(...mediaMissing(opts))
  if (needsMain(kind) && !opts.TC_MAIN_URL?.trim()) m.push(kind === 'unmanic-worker' ? 'the address of your main Unmanic' : 'the address of your Tdarr server')
  return m
}

export function TranscodePicker({ kind, opts, setOpts, onState }: {
  kind: TcKind
  opts: Record<string, string>; setOpts: (f: (v: Record<string, string>) => Record<string, string>) => void
  onState: (s: { missing: string[] }) => void
}) {
  const [facts, setFacts] = useState<Facts | null>(null)
  const set = (k: string, v: string) => setOpts(o => ({ ...o, [k]: v }))

  useEffect(() => {
    void apiJson<{ data: Facts }>('/api/catalogue/wizard/transcode').then(r => { if (r.ok && r.body?.data) setFacts(r.body.data) })
  }, [])
  // A worker starts from the Unmanic the plug-in already reads.
  useEffect(() => {
    if (kind === 'unmanic-worker' && facts?.unmanicUrl && !opts.TC_MAIN_URL) set('TC_MAIN_URL', facts.unmanicUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts, kind])
  const missing = tcMissing(kind, opts)
  useEffect(() => { onState({ missing }) }, [missing.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  const accel = (opts.TC_ACCEL || 'auto') as 'auto' | 'vaapi' | 'nvidia' | 'cpu'
  const ex = EXPLAIN[kind]
  const workers = Number(opts.UNMANIC_WORKERS || 1)

  return (
    <div className="space-y-4 min-w-0">
      <div className="rounded-lg border px-4 py-3" style={{ borderColor: alpha('var(--accent)', 40), background: `linear-gradient(135deg, ${alpha('var(--accent)', 8)}, var(--ground-inset))` }}>
        <p className="text-[14px]" style={{ color: 'var(--text-soft)' }}>{ex.what}</p>
      </div>

      {/* Hardware */}
      <div className="rounded-lg border p-4 space-y-3 min-w-0" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
        <p className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>Hardware acceleration</p>
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          A GPU does this several times faster than the CPU. HyperProx looks at the node you pick in step 3 and shows what it has there; Automatic uses its Intel or AMD graphics, else its NVIDIA card, else the CPU.
        </p>
        <Segmented label="Hardware acceleration" value={accel} onChange={v => set('TC_ACCEL', v)}
          items={(['auto', 'vaapi', 'nvidia', 'cpu'] as const).map(a => [a, ACCEL_WORDS[a]] as [typeof a, string])} />
        <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {accel === 'nvidia'
            ? 'NVIDIA works only when the node already has its driver loaded; HyperProx never installs or changes a driver on a node. The container gets the same version of the user-space libraries.'
            : accel === 'cpu' ? 'Works everywhere, but keeps every core busy and is much slower.'
              : accel === 'vaapi' ? 'Shares the node\'s render device and its render group with the container.'
                : 'Nothing is guessed: if the node has nothing to share, the plan says CPU.'}
        </p>
      </div>

      {hasLibrary(kind) && (
        <MediaSource opts={opts} set={set} facts={facts} layoutLine="The library is /data/media inside the container: the same folder the Arr Stack fills, at the same path." />
      )}

      {needsMain(kind) && (
        <div className="rounded-lg border p-4 space-y-3 min-w-0" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
          <p className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>{kind === 'unmanic-worker' ? 'Your main Unmanic' : 'Your Tdarr server'}</p>
          <Field label="Address" hint={kind === 'unmanic-worker' ? 'Its IP address and port, like 10.0.0.30:8888. It must answer now: the preview asks it.' : 'Its IP address and web port, like 10.0.0.30:8265. The node connects to the server\'s node port (8266) at the same address; the preview checks that from the node.'}>
            <input value={opts.TC_MAIN_URL ?? ''} onChange={e => set('TC_MAIN_URL', e.target.value.trim())} placeholder={kind === 'unmanic-worker' ? '10.0.0.30:8888' : '10.0.0.30:8265'} style={INPUT} autoCapitalize="none" spellCheck={false} />
          </Field>
        </div>
      )}

      {isUnmanic(kind) && (
        <div className="rounded-lg border p-4 space-y-3 min-w-0" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
          <p className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>Workers</p>
          <Field label="Workers" hint="How many files are converted at once. Two suits a GPU; on the CPU one worker already uses every core.">
            <input type="number" min={1} max={16} value={opts.UNMANIC_WORKERS ?? ''} onChange={e => set('UNMANIC_WORKERS', e.target.value)} style={INPUT} inputMode="numeric" />
          </Field>
          {accel === 'cpu' && workers > 1 && <p className="text-[12px]" style={{ color: 'var(--warn-2)' }}>On the CPU every worker uses all the cores, so more than one only makes each slower.</p>}
          {kind === 'unmanic' && (
            <label className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: 'var(--text)' }}>
              <input type="checkbox" className="mt-1" checked={opts.UNMANIC_SCAN !== '0'} onChange={e => set('UNMANIC_SCAN', e.target.checked ? '1' : '0')} />
              <span>Scan the library on a schedule
                <span className="block text-[12px]" style={{ color: 'var(--text-dim)' }}>Looks for new files once a day. A first library called Media is made at /data/media with no plug-in enabled, so nothing about your files changes until you choose one in Unmanic.</span>
              </span>
            </label>
          )}
        </div>
      )}

      <div className="rounded-lg border p-4 space-y-2 min-w-0" style={{ borderColor: 'var(--border-soft)', background: 'var(--ground-inset)' }}>
        <p className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>{needsMain(kind) ? 'How it joins' : 'More nodes later'}</p>
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{ex.extras}</p>
        <p className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {isUnmanic(kind) ? 'Unmanic has no sign-in' : 'Tdarr has no sign-in by default'}: anyone on your network can open it. HyperProx gives it no public name and no port forward. Nothing here needs a password, so nothing is put in the vault.
          {kind === 'tdarr' || kind === 'tdarr-node' ? ' HyperProx has no Tdarr plug-in yet, so after the install it links to Tdarr; add your library folders there.' : ''}
        </p>
      </div>
    </div>
  )
}

/**
 * Step 3's panel: what the chosen node has to give, and whether the choice made in step 1 can be honoured there. The
 * look is read-only. A node with no login, or one that cannot be reached, is said so and the preview refuses it.
 */
export function NodeHardware({ node, choice }: { node: string; choice: string }) {
  const [hw, setHw] = useState<HwFacts | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => {
    if (!node) return
    let live = true
    setState('loading')
    void apiJson<{ data: HwFacts }>(`/api/catalogue/wizard/transcode/hardware?node=${encodeURIComponent(node)}`).then(r => {
      if (!live) return
      if (r.ok && r.body?.data) { setHw(r.body.data); setState('ready') } else setState('error')
    })
    return () => { live = false }
  }, [node])
  if (!node) return null
  const want = (choice || 'auto') === 'auto' ? hw?.auto : (choice as 'vaapi' | 'nvidia' | 'cpu')
  const ok = !hw || want === 'cpu' || (want === 'vaapi' && hw.vaapi) || (want === 'nvidia' && hw.nvidia)
  return (
    <div className="rounded-lg border p-4 space-y-2 min-w-0" style={{ borderColor: ok ? 'var(--border-soft)' : 'color-mix(in srgb, var(--warn) 45%, transparent)', background: 'var(--ground-inset)' }}>
      <p className="font-display text-[17px] font-semibold" style={{ color: 'var(--text-bright)' }}>Hardware on {node}</p>
      {state === 'loading' && <p className="text-[12px] animate-pulse" style={{ color: 'var(--text-dim)' }}>Looking at {node}…</p>}
      {state === 'error' && <p className="text-[12px]" style={{ color: 'var(--warn-2)' }}>HyperProx could not look at {node} (it needs the node login). The preview will say what it finds.</p>}
      {state === 'ready' && hw && (
        <ul className="space-y-1 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          <li>Intel / AMD graphics: {hw.vaapi ? <strong style={{ color: 'var(--good)' }}>{hw.vaapi.names.join(', ')}</strong> : 'none'}</li>
          <li>NVIDIA: {hw.nvidia ? <strong style={{ color: 'var(--good)' }}>{hw.nvidia.names.join(', ')} (driver {hw.nvidia.driver})</strong> : 'none with a loaded driver'}</li>
          <li>This install will use: <strong style={{ color: 'var(--text-bright)' }}>{ACCEL_WORDS[want ?? 'cpu']}</strong>{(choice || 'auto') === 'auto' ? ' (automatic)' : ''}</li>
        </ul>
      )}
      {state === 'ready' && !ok && <p className="text-[12px]" style={{ color: 'var(--warn-2)' }}>{node} cannot give {ACCEL_WORDS[want ?? 'cpu']}. Go back and pick another choice, or pick another node here.</p>}
    </div>
  )
}
