// The Pi-hole and AdGuard Home recipes: pinned versions, the options, the install scripts built from them (syntax-checked
// with bash, no secret on a command line, DNS bound to the container's own address, AdGuard's first run on loopback
// only), their fingerprints (against the recorded answers of real installs), the service-scan probes, and where they
// sit in the catalogue.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { CATALOGUE, CATEGORY_LABELS, checkOptions, findRecipe, healthProblem, wizardRecipes } from '../src/lib/catalogue'
import { installScript, manualCommands } from '../src/lib/install-script'
import {
  ADGUARD_DETECT, ADGUARD_RECIPE, ADGUARD_RECIPE_ID, ADGUARD_SCRIPT, ADGUARD_SHA256_AMD64, ADGUARD_VERSION, DNS_BLOCKER_RECIPES, PIHOLE_DETECT, PIHOLE_IMAGE,
  PIHOLE_RECIPE, PIHOLE_RECIPE_ID, PIHOLE_SCRIPT, PIHOLE_VERSION, checkDnsOptions, piholeCompose, validUpstream,
} from '../src/lib/dns-blocker/recipes'
import { PROBES } from '@hyperprox/hardware/service-probes'
import fs from 'node:fs'
import path from 'node:path'

/** A recorded answer of a real install (names and addresses replaced): test/fixtures/dns-blocker. */
const fixtureText = (kind: 'pihole' | 'adguard', name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'dns-blocker', kind, name), 'utf8')

const PW = 'generated-test-password'

function script(id: string, env: Record<string, string> = {}) {
  const r = findRecipe(id)!
  return installScript(r, 'debian', { [(r.firstRun as any).passwordEnv]: PW, ...env })
}
const bashOk = (s: string) => spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' })

test('both recipes are in the catalogue, listed under DNS and network, and never offered to the AI assistant', () => {
  for (const id of [PIHOLE_RECIPE_ID, ADGUARD_RECIPE_ID]) {
    const r = findRecipe(id)!
    assert.ok(r, id)
    assert.equal(r.category, 'network')
    assert.equal(r.wizard, false, 'it cannot hand the generated password back to the person who asked')
    assert.equal(r.firstRun.kind, 'env-admin')
    assert.equal(r.pointNetwork, true)
    assert.ok(r.firstLogin && r.notes!.length >= 3)
    assert.ok(!wizardRecipes().includes(r))
  }
  assert.equal(CATEGORY_LABELS.network, 'DNS and network')
  assert.deepEqual(DNS_BLOCKER_RECIPES.map(r => r.id), ['pihole', 'adguard-home'])
  assert.equal(new Set(CATALOGUE.map(r => r.id)).size, CATALOGUE.length, 'no recipe id is used twice')
})

test('versions are pinned: Pi-hole by tag and digest, AdGuard Home by version and the published checksum', () => {
  assert.match(PIHOLE_IMAGE, /^pihole\/pihole:2026\.10\.1@sha256:[0-9a-f]{64}$/)
  assert.equal(PIHOLE_VERSION, '2026.10.1')
  assert.match(ADGUARD_SHA256_AMD64, /^[0-9a-f]{64}$/)
  assert.equal(ADGUARD_VERSION, 'v0.107.79')
  for (const s of [piholeCompose(), PIHOLE_SCRIPT, ADGUARD_SCRIPT]) assert.doesNotMatch(s, /:latest\b|releases\/latest/, 'never an unpinned version')
  assert.match(ADGUARD_SCRIPT, new RegExp(`releases/download/${ADGUARD_VERSION}/AdGuardHome_linux_amd64\\.tar\\.gz`))
  assert.ok(ADGUARD_SCRIPT.indexOf('sha256sum -c') < ADGUARD_SCRIPT.indexOf('tar -xzf'), 'checked before it is unpacked')
})

test('the install scripts are valid bash and stop at the first failure', () => {
  for (const id of [PIHOLE_RECIPE_ID, ADGUARD_RECIPE_ID]) {
    const s = script(id)
    assert.equal(s.split('\n')[0], 'set -e')
    const r = bashOk(s)
    assert.equal(r.status, 0, `${id}: ${r.stderr}`)
    assert.ok(manualCommands(findRecipe(id)!, 'debian').length > 5)
  }
})

test('a blocker is never installed with no password: the script refuses to be built without one', () => {
  for (const id of [PIHOLE_RECIPE_ID, ADGUARD_RECIPE_ID]) assert.throws(() => installScript(findRecipe(id)!, 'debian', {}), /does not start with a default or empty password/)
})

test('DNS listens on the container\'s own address only, in both', () => {
  const c = piholeCompose()
  for (const p of ['53:53/tcp', '53:53/udp', '80:80/tcp']) assert.match(c, new RegExp(`"@LAN_IP@:${p.replace(/\//g, '\\/')}"`))
  assert.doesNotMatch(c, /"53:53|"80:80|0\.0\.0\.0|network_mode: host/, 'no port is published on every interface')
  const s = script(PIHOLE_RECIPE_ID)
  assert.match(s, /LAN_IP=\$\(ip -4 -o addr show eth0/)
  assert.match(s, /sed -i "s\|@LAN_IP@\|\$LAN_IP\|g"/)
  assert.match(ADGUARD_SCRIPT, /"dns":\{"ip":"%s","port":53\}/)
  assert.match(ADGUARD_SCRIPT, /"web":\{"ip":"%s","port":80\}/)
  assert.doesNotMatch(ADGUARD_SCRIPT, /"ip":"0\.0\.0\.0"/)
})

test('Pi-hole\'s upstreams are set through its API, not the environment (which would lock them), and its password is a secret file', () => {
  const c = piholeCompose()
  assert.doesNotMatch(c, /FTLCONF_dns_upstreams|WEBPASSWORD:|FTLCONF_webserver_api_password/, 'an environment setting is read-only through the API; a password there is visible')
  assert.match(c, /WEBPASSWORD_FILE: pihole_password/)
  assert.match(c, /secrets:\n  pihole_password:\n    file: \.\/secrets\/pihole_password/)
  assert.match(PIHOLE_SCRIPT, /chmod 700 \$D\/secrets/)
  assert.match(PIHOLE_SCRIPT, /request = "PATCH"/)
  assert.match(PIHOLE_SCRIPT, /\{"config":\{"dns":\{"upstreams":\[%s\]\}\}\}/)
})

test('AdGuard Home\'s first run is on loopback only, before anything is reachable on the network', () => {
  const s = ADGUARD_SCRIPT
  const first = s.indexOf('--web-addr 127.0.0.1:3000')
  assert.ok(first > 0)
  assert.ok(first < s.indexOf('/control/install/configure'), 'started on loopback, then configured')
  assert.ok(s.indexOf('/control/install/configure') < s.indexOf('-s install'), 'the service is installed only after it has an admin')
  assert.doesNotMatch(s, /-s install[\s\S]*install\/configure/, 'the service never runs the open setup page')
})

test('no secret is ever on a command line: passwords and sessions reach curl on standard input or in a root-only file', () => {
  for (const s of [PIHOLE_SCRIPT, ADGUARD_SCRIPT]) {
    // Only the curl part of a pipeline is a process with arguments; printf is a shell builtin and shows nothing.
    const curls = s.split('\n').filter(l => !l.trim().startsWith('#')).flatMap(l => l.split('|')).filter(seg => /\bcurl\b/.test(seg))
    assert.ok(curls.length >= 3)
    for (const c of curls) assert.doesNotMatch(c, /\$PW|\$SID|\$ADGUARD_PASSWORD|\$PIHOLE_PASSWORD|-u |--user /, `a secret on a curl command line: ${c}`)
    assert.match(s, /curl [^\n]*-K -/)
    assert.match(s, /unset PW/)
  }
  // The password is exported once, for the script's own shell, and the script moves it to its own variable and unsets it.
  assert.match(script(PIHOLE_RECIPE_ID), /^export PIHOLE_PASSWORD=/m)
  assert.match(PIHOLE_SCRIPT, /^unset PIHOLE_PASSWORD$/m)
  assert.match(ADGUARD_SCRIPT, /^unset ADGUARD_PASSWORD$/m)
})

test('upstream option: blank means the container\'s own resolvers; a list is checked', () => {
  const r = findRecipe(PIHOLE_RECIPE_ID)!
  assert.deepEqual(checkOptions(r, {}).errors, [])
  assert.equal(checkOptions(r, {}).values.DNS_UPSTREAMS, '')
  assert.equal(checkOptions(r, { DNS_UPSTREAMS: '1.1.1.1, 9.9.9.9#53' }).values.DNS_UPSTREAMS, '1.1.1.1, 9.9.9.9#53')
  for (const bad of ['dns.example.com', '1.1.1.1; reboot', '$(id)', '1.1.1.1 9.9.9.9 8.8.8.8 8.8.4.4 1.0.0.1', 'https://dns.example.com/dns-query']) {
    assert.ok(checkOptions(r, { DNS_UPSTREAMS: bad }).errors.length > 0, `refused: ${bad}`)
  }
  assert.deepEqual(checkDnsOptions({ DNS_UPSTREAMS: '2606:4700:4700::1111' }), [])
  const withUp = script(PIHOLE_RECIPE_ID, { DNS_UPSTREAMS: '9.9.9.9,1.1.1.1' })
  assert.match(withUp, /^export DNS_UPSTREAMS='9\.9\.9\.9,1\.1\.1\.1'$/m)
  assert.match(script(ADGUARD_RECIPE_ID), /awk '\/\^nameserver\/ && \$2 !~ \/\^\(127\\\.\|::1\$\)\/ \{ print \$2 \}' \/etc\/resolv\.conf/, 'the container\'s own resolvers, never a loopback one')
})

test('the resolvers default to the ones the container was given, and 1.1.1.1 only when it has none', () => {
  const sh = `
    ${'UP="$DNS_UPSTREAMS"'}
    if [ -z "$UP" ]; then UP=$(printf 'nameserver 127.0.0.53\\nnameserver 192.0.2.53\\nnameserver ::1\\nnameserver 192.0.2.54\\n' | awk '/^nameserver/ && $2 !~ /^(127\\.|::1$)/ { print $2 }' | paste -sd, -); fi
    [ -n "$UP" ] || UP=1.1.1.1
    printf '%s' "$UP"`
  const run = (env: string) => spawnSync('bash', ['-c', sh], { encoding: 'utf8', env: { PATH: process.env.PATH!, DNS_UPSTREAMS: env } }).stdout
  assert.equal(run(''), '192.0.2.53,192.0.2.54')
  assert.equal(run('9.9.9.9'), '9.9.9.9')
})

test('health and detection: the recorded answers of real installs match their own recipe and nobody else\'s', () => {
  const info = { status: 200, headers: {}, body: fixtureText('pihole', 'login-info.json') }
  const login = { status: 200, headers: {}, body: fixtureText('adguard', 'login.html') }
  assert.equal(healthProblem(PIHOLE_RECIPE, 200, info.body), null)
  assert.match(healthProblem(PIHOLE_RECIPE, 200, '<html>not it</html>')!, /does not contain/)
  assert.equal(healthProblem(ADGUARD_RECIPE, 200, login.body), null)
  assert.ok(healthProblem(ADGUARD_RECIPE, 502, ''))
  assert.deepEqual(PIHOLE_DETECT[0].match(info), { version: null })
  assert.deepEqual(ADGUARD_DETECT[0].match(login), { version: null })
  assert.equal(PIHOLE_DETECT[0].match({ ...info, status: 503 }), null)
  assert.equal(PIHOLE_DETECT[0].match({ ...info, body: '{"dns":true}' }), null, 'both its marks')
  assert.equal(ADGUARD_DETECT[0].match({ ...login, body: '<html><title>Login</title></html>' }), null, 'any login page is not AdGuard Home')
  for (const [id, a] of [[PIHOLE_RECIPE_ID, info], [ADGUARD_RECIPE_ID, login]] as const) {
    const others = CATALOGUE.filter(r => r.id !== id && r.detect)
    for (const o of others) assert.equal(o.detect!.map(f => f.match(a)).find(Boolean) ?? null, null, `${o.id} must not match ${id}'s answer`)
  }
})

test('the service scan finds both, by their own answers, on their web port', () => {
  const find = (key: string) => PROBES.find((p: any) => p.key === key)
  const pi = find('pihole')!, ag = find('adguard')!
  assert.ok(pi && ag)
  assert.equal(pi.port, 80); assert.equal(ag.port, 80)
  assert.equal(pi.recipeId, PIHOLE_RECIPE_ID); assert.equal(ag.recipeId, ADGUARD_RECIPE_ID)
  assert.equal(pi.pluginId, 'pihole'); assert.equal(ag.pluginId, 'adguard')
  assert.equal(pi.setting, null, 'each plug-in keeps its own list, so there is no address setting to fill')
  assert.equal(pi.page, '/plugins/pihole'); assert.equal(ag.page, '/plugins/adguard')
  assert.equal(pi.match(200, fixtureText('pihole', 'login-info.json')), true)
  assert.equal(ag.match(200, fixtureText('adguard', 'login.html')), true)
  assert.equal(pi.match(200, fixtureText('adguard', 'login.html')), false)
  assert.equal(ag.match(200, fixtureText('pihole', 'login-info.json')), false)
  assert.equal(pi.match(404, ''), false); assert.equal(ag.match(500, fixtureText('adguard', 'login.html')), false)
  for (const p of PROBES.filter((x: any) => x.key !== 'pihole' && x.key !== 'adguard')) {
    for (const body of [fixtureText('pihole', 'login-info.json'), fixtureText('adguard', 'login.html')]) {
      let m = false
      try { m = Boolean((p as any).match(200, body)) } catch { m = false }
      // Probes that accept any 2xx body naming their app (Tautulli's is the loosest) must still not claim these.
      assert.equal(m, false, `${(p as any).key} must not claim a blocker's answer`)
    }
  }
})

test('upstreams: real IPv4 or IPv6 addresses with an optional valid port, nothing else', () => {
  for (const ok of ['1.1.1.1', '9.9.9.9#5353', '2606:4700:4700::1111', '2001:db8::1#53', '255.255.255.255']) assert.ok(validUpstream(ok), ok)
  for (const bad of ['999.1.1.1', '1.1.1', '1.1.1.1#0', '1.1.1.1#70000', '1.1.1.1#', ':::', '1.1.1.1#53#1', 'abcd', '1.1.1.1:53']) assert.ok(!validUpstream(bad), bad)
  assert.ok(checkDnsOptions({ DNS_UPSTREAMS: '999.1.1.1' }).length > 0)
})

test('AdGuard Home gets ports as host:port and IPv6 with a port in brackets', () => {
  const line = ADGUARD_SCRIPT.split('\n').find(l => l.startsWith('UPJSON='))!
  const run = spawnSync('bash', ['-c', `UP='1.1.1.1,9.9.9.9#5353,2001:db8::1,2001:db8::2#5353'\n${line}\nprintf '%s' "$UPJSON"`], { encoding: 'utf8' })
  assert.equal(run.stdout, '"1.1.1.1","9.9.9.9:5353","2001:db8::1","[2001:db8::2]:5353"')
})

test('AdGuard Home leaves no first-run log behind', () => {
  assert.match(ADGUARD_SCRIPT, /rm -f \/tmp\/adguard-first-run\.log/)
})
