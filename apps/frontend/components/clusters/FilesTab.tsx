'use client'

// Send files: placeholder until file copies are built (see the Files section of the README).

export function FilesTab({ clusterId }: { clusterId: string }) {
  void clusterId
  return (
    <div className="rounded-lg border border-dashed p-4 text-sm" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
      <b style={{ color: 'var(--text)' }}>Send files: coming soon.</b> Copying folders between clusters is not finished, so it is not offered yet.
    </div>
  )
}
