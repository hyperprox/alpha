'use client'

// =============================================================================
//  HaBadge — a guest's HA status in a list row
//
//    const badges = useHaBadges()                          // once per list: GET /api/ha/badges
//    <HaBadge info={badges.get('ct:901')} />               // per row
//    <HaBadge info={badges.get(sidOf('lxc', 901))} showUnprotected />
//
//  Shows nothing for a guest HA does not manage (unless showUnprotected), "HA"
//  with its home for one it does, and turns amber when the guest has a
//  warning (no home, or hardware tied to a node its home does not put first).
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { Tag } from './ui'
import type { HaBadgeInfo } from './types'

export function useHaBadges(refreshMs = 30_000) {
  const [map, setMap] = useState<Record<string, HaBadgeInfo>>({})
  const load = useCallback(async () => {
    const r = await apiJson<{ data: Record<string, HaBadgeInfo> }>('/api/ha/badges')
    if (r.ok && r.body) setMap(r.body.data)
  }, [])
  useEffect(() => {
    void load()
    if (!refreshMs) return
    const t = setInterval(load, refreshMs)
    return () => clearInterval(t)
  }, [load, refreshMs])
  return { get: (sid: string) => map[sid], reload: load, all: map }
}

export function HaBadge({ info, showUnprotected = false }: { info?: HaBadgeInfo; showUnprotected?: boolean }) {
  if (!info) return null
  if (!info.protected) return showUnprotected ? <Tag tone="muted" title="Not protected: stays down after a node failure">no HA</Tag> : null
  const home = info.home === 'none' ? 'no home'
    : info.home === 'only' ? `only ${info.homeNodes.join('/')}`
    : info.home === 'avoid' ? `not ${info.homeNodes.join('/')}`
    : `home ${info.homeNodes.join('/')}`
  const tone = info.state === 'error' ? 'crit' : info.warn ? 'warn' : info.state === 'stopped' ? 'muted' : 'violet'
  const title = [
    'Restarted on another node if its node fails. Started and stopped through HA.',
    info.state ? `HA state: ${info.state}.` : '',
    info.warn ?? '',
  ].filter(Boolean).join(' ')
  return <Tag tone={tone} title={title}>HA · {home}{info.warn ? ' ⚠' : ''}</Tag>
}
