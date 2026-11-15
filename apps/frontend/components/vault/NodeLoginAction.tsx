'use client'

// The one "Add node login" action, the same words and the same destination on every page that needs a login
// for the nodes (Updates, VPN, Devices, Terminal). See lib/node-login.ts.
import Link from 'next/link'
import { styles } from '@/components/visual/kit'
import { Notice } from '@/components/vault/ui'
import { NODE_LOGIN_HREF, NODE_LOGIN_LABEL, NODE_LOGIN_WHY, isNoLoginText, withoutLoginAdvice } from '@/lib/node-login'

/** `href`: another place to add it (a remote server's own logins, under Edit server). Default: home's checklist. */
export function NodeLoginAction({ small, why, href = NODE_LOGIN_HREF }: { small?: boolean; why?: boolean; href?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {why && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{NODE_LOGIN_WHY}</span>}
      <Link href={href} className={`${styles.btn} ${styles.btnPri}`}
        style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', ...(small ? { minHeight: 30, padding: '4px 10px', fontSize: 12.5 } : {}) }}>
        {NODE_LOGIN_LABEL}
      </Link>
    </span>
  )
}

/** An error line: the "no saved login" refusal is shown without its own (differently worded) advice, with the one action beside it. */
export function NodeLoginNotice({ text, kind = 'error' }: { text: string; kind?: 'error' | 'warn' | 'info' }) {
  if (!isNoLoginText(text)) return <Notice kind={kind}>{text}</Notice>
  return <Notice kind="warn">{withoutLoginAdvice(text)} <NodeLoginAction small /></Notice>
}
