'use client'

// The Automatic reboots settings: which machines, the window, the days, the time zone and "only when nobody is
// watching". Used by the Schedule card's "Edit schedule…" dialog. Saving goes through the page's confirmed,
// audited call; nothing here talks to the API.

import { useState } from 'react'
import type { UpdatesRebootSettings } from '@hyperprox/types'
import { styles } from '@/components/visual/kit'
import { Btn } from './ui'
import { DAY_NAMES, daysText, windowText } from '@/lib/auto-reboots'

export function RebootSettingsForm({ settings, busy, onSave, onCancel }: {
  settings: UpdatesRebootSettings; busy: boolean; onSave: (s: UpdatesRebootSettings) => void; onCancel: () => void
}) {
  const [form, setForm] = useState<UpdatesRebootSettings>({ ...settings, window: { ...settings.window, days: [...settings.window.days] } })
  return (
    <form className="grid gap-3 sm:grid-cols-2" aria-label="Automatic reboot settings" onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.nodes} onChange={e => setForm({ ...form, nodes: e.target.checked })} /> Reboot nodes automatically</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.guests} onChange={e => setForm({ ...form, guests: e.target.checked })} /> Reboot guests that ask for it</label>
      <label className="text-sm">Window starts
        <input type="time" className={`${styles.input ?? ''} mt-1 block w-full`} value={form.window.start} onChange={e => setForm({ ...form, window: { ...form.window, start: e.target.value } })} />
      </label>
      <label className="text-sm">Lasts
        <select className={`${styles.input ?? ''} mt-1 block w-full`} value={form.window.hours} onChange={e => setForm({ ...form, window: { ...form.window, hours: Number(e.target.value) } })}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map(h => <option key={h} value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
        </select>
      </label>
      <fieldset className="text-sm sm:col-span-2">
        <legend>Days</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {DAY_NAMES.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input type="checkbox" checked={form.window.days.includes(i)}
                     onChange={e => setForm({ ...form, window: { ...form.window, days: e.target.checked ? [...form.window.days, i].sort() : form.window.days.filter(x => x !== i) } })} />{d}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="text-sm">Time zone
        <input className={`${styles.input ?? ''} mt-1 block w-full font-mono`} value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} />
      </label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.quiet} onChange={e => setForm({ ...form, quiet: e.target.checked })} /> Only when nobody is watching (waits while Plex has streams, asking again every 10 minutes)</label>
      <p className="text-xs sm:col-span-2" style={{ color: 'var(--text-muted)' }}>
        {windowText(form.window)} {daysText(form.window.days)}, {form.timezone}. Nodes go one at a time, HyperProx&apos;s own node last; the first problem stops the run safely and sends one message.
      </p>
      <div className="flex gap-2 sm:col-span-2">
        <Btn kind="primary" type="submit" disabled={busy || !form.window.days.length}>Save</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </form>
  )
}
