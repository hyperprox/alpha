#!/usr/bin/env node
// =============================================================================
//  HyperProx screenshots, taken from the demo (pnpm demo) — never from a real install.
//
//  Signs in to the demo, opens each main page at desktop (1440x900) and phone
//  (390x844) size, in the dark and the light theme, and saves a PNG of each into
//  docs/screenshots/. It refuses to run against anything that does not say it is
//  the demo, so it cannot photograph a real HyperProx by mistake.
//
//  Needs Playwright and a Chromium:  npm i playwright && npx playwright install chromium
//  (or point CHROMIUM at an installed one).
//
//    node scripts/screenshots.mjs [demo URL] [output folder]
//    node scripts/screenshots.mjs http://127.0.0.1:3100 docs/screenshots
//
//  ONLY=dashboard,storage limits it to some pages; SIZE=desktop and THEME=dark to one
//  size or theme. REPORT=/tmp/shots.json also writes each page's visible text and any
//  API read the demo did not answer, so a reviewer can search the text for anything
//  that should not be there.
// =============================================================================
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = (process.argv[2] || process.env.DEMO_URL || 'http://127.0.0.1:3100').replace(/\/$/, '')
const OUT = path.resolve(process.argv[3] || 'docs/screenshots')

export const PAGES = [
  ['login', '/login'],
  ['dashboard', '/dashboard'],
  ['command-center', '/clusters'],
  ['remote-cluster', '/clusters/c3f1a2b4c5d'],
  ['infrastructure', '/infrastructure'],
  ['storage', '/storage'],
  ['monitoring', '/monitoring'],
  ['updates', '/updates'],
  ['high-availability', '/ha'],
  ['certificates', '/certificates'],
  ['dns', '/dns'],
  ['proxy', '/proxy'],
  ['vpn', '/vpn'],
  ['plugins', '/plugins'],
  ['plugin-home-assistant', '/plugins/home-assistant'],
  ['plugin-home-assistant-rooms', '/plugins/home-assistant', { scrollTo: 'Living Room' }],
  ['plugin-plex', '/plugins/plex'],
  ['plugin-arr-stack', '/plugins/arrstack'],
  ['plugin-unmanic', '/plugins/unmanic'],
  ['plugin-router', '/plugins/mikrotik'],
  ['plugin-meshcentral', '/plugins/meshcentral'],
  ['catalogue', '/catalogue'],
  ['settings', '/settings'],
]
const SIZES = [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]
const THEMES = ['dark', 'light']

const only = (process.env.ONLY || '').split(',').filter(Boolean)
const pages = only.length ? PAGES.filter(([name]) => only.includes(name)) : PAGES
const sizes = SIZES.filter(([n]) => !process.env.SIZE || n === process.env.SIZE)
const themes = THEMES.filter(t => !process.env.THEME || t === process.env.THEME)

async function main() {
  // Refuse anything that is not the demo API.
  const st = await fetch(`${BASE}/api/auth/status`).then(r => r.json()).catch(() => null)
  if (!st || st.demo !== true) {
    console.error(`${BASE} is not the HyperProx demo (its /api/auth/status does not say demo: true). Start it with pnpm demo.`)
    process.exit(2)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
  const report = {}
  for (const [sizeName, viewport, mobile] of sizes) {
    for (const theme of themes) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, colorScheme: theme, reducedMotion: 'reduce' })
      await ctx.addInitScript(t => { try { localStorage.setItem('hyperprox-theme', t) } catch {} }, theme)
      // Sign in the way a visitor would: the demo accepts anything.
      const login = await ctx.newPage()
      await login.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
      for (const [name, url, opts = {}] of pages) {
        const page = name === 'login' ? login : await ctx.newPage()
        const missed = []
        page.on('response', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && r.status() === 404) missed.push(u.pathname) })
        if (name !== 'login') {
          await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {})
          await page.waitForTimeout(2500)
          // Scroll the page body to a heading, for a shot of what sits below the first screen.
          if (opts.scrollTo) {
            await page.evaluate(t => {
              const hits = [...document.querySelectorAll('#main *')].filter(e => e.children.length === 0 && e.textContent.trim().toLowerCase() === t)
              hits.at(-1)?.scrollIntoView({ block: 'start' })
            }, opts.scrollTo.toLowerCase())
            await page.waitForTimeout(600)
          }
        } else await page.waitForTimeout(800)
        const file = `${name}-${sizeName}-${theme}.png`
        await page.screenshot({ path: path.join(OUT, file), animations: 'disabled' })
        report[file] = { url, text: (await page.innerText('body').catch(() => '')).slice(0, 20000), missed: [...new Set(missed)] }
        console.log(file, missed.length ? `(not answered: ${[...new Set(missed)].join(', ')})` : '')
        if (name === 'login') {
          await page.click('button[type=submit]')
          await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 30_000 })
        } else await page.close()
      }
      await ctx.close()
    }
  }
  await browser.close()
  if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, JSON.stringify(report, null, 1))
}

main().catch(e => { console.error(e); process.exit(1) })
