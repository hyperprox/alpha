# Proxies

HyperProx drives reverse proxies through one interface (`apps/api/src/lib/proxy`). The Proxy page, the AI wizard's proxy step and the certificate inventory all go through it, so a second Nginx Proxy Manager, or a Caddy beside an NPM, is just another instance.

| Kind | How HyperProx talks to it | Hosts it treats as its own | "Disabled" means | Certificates |
|---|---|---|---|---|
| Nginx Proxy Manager | NPM's API (`/api`), an email and password | Every host (NPM is driven whole, as it always was) | NPM stops serving the host | Listed and requested through NPM |
| Traefik | Reads `/api/http/routers` and `/services`; writes **one file of its own** for the file provider | Routers in that file (`hpx-…`) | The router gets the `hpx-disabled` allow-list: Traefik answers 403 | Traefik's own (a certificate resolver, if set) |
| Caddy | The admin API (`/config/`, `/id/`) | Routes with an `@id` of `hpx-…` | The route answers 503 | Caddy's automatic HTTPS |
| HAProxy | The Data Plane API v3, in transactions | Backends `hpx_…` and their `use_backend` rule in one frontend | The server goes into maintenance: 503 | Listed from Data Plane storage |
| Pangolin | The integration API (`/v1`) with an organisation key | Resources whose niceId is `hpx-…` | Pangolin stops serving the resource | Pangolin's own |

Anything else on a proxy (Traefik labels or other files, a hand-written Caddy route, an HAProxy rule pointing at another backend, a Pangolin resource made in its UI) is **shown read-only** with the instance that owns it, and HyperProx refuses every write to it before the proxy is asked. On Caddy, HAProxy and Pangolin a host is HyperProx's only when HyperProx's own record says it made it (the instance's `owned` list) **and** it carries the `hpx-`/`hpx_` prefix: a hand-made route that happens to use the prefix stays read-only. On Traefik, ownership is HyperProx's own file. The one exception is NPM: HyperProx has always edited every NPM host, and still does.

## Instances

- **Several at once.** Add as many instances as you like, two of the same kind included. Every host in the table names its instance.
- **The Settings NPM.** The NPM login in Settings → Proxy is the instance `npm`. It keeps working unchanged; it is changed and removed in Settings, not on the Proxy page.
- **Bring Your Own or Managed.** Bring Your Own is a proxy you run: you give HyperProx a login. Managed is one the Catalogue installed into a container HyperProx knows (node and container id are recorded), so Updates can update it and the Traefik file can be written through the container instead of SSH.
- **Secrets** (passwords, keys, API keys) are kept in the vault, one item per instance (`hyperprox:proxy-instance/<id>`). The `ProxyInstance` table holds only names, URLs and options. Forgetting an instance removes its vault item and changes nothing on the proxy.

## Writes: preview, apply, read back

Every change is two calls:

1. `POST /api/proxy/instances/:id/preview` with `{ action, hostId?, host? }` (`create`, `update`, `delete`, `enable`, `disable`). HyperProx reads the proxy, refuses what must not happen (a read-only host, a name another host on that proxy already serves), and returns a plan: each change and what it means, in words. A name that another instance also serves is a warning, not a refusal.
2. `POST /api/proxy/plans/:planId/apply`. Only the plan's id is accepted, only by whoever previewed it, once, within ten minutes. HyperProx reads the host again first: if **anything** about it changed since the preview (the whole host is fingerprinted: on NPM every field except `modified_on` and nginx's own status), nothing is done. After the write it reads the proxy again and compares every field the plan covers. A proxy that says OK while the host is not what was planned is reported as a failure.

**An update is a patch.** Only the fields you send change; everything else keeps its current value. On NPM that includes the certificate, force-HTTPS, HSTS, HTTP/2, caching, block-exploits, websockets, the advanced configuration, the access list and custom locations: HyperProx reads the host, lays your fields over it, and sends the whole merged host. The preview lists every field that changes in words (`certificate: #5 example.com → none`, `websockets: off → on`), warns when a certificate, force-HTTPS, HSTS or HTTP/2 is being taken off, and refuses an edit that changes nothing (nothing is sent to the proxy).

**A create that fails part-way** (the proxy made the host and then answered with an error) is reported as exactly what now exists, with a `cleanup` plan that removes that host and nothing else; apply it like any other plan.

Each apply is written to the audit log (`proxy.host.<action>`), with who, the names and whether the read-back matched; never a credential.

### For scripts

The old `POST/PUT/DELETE /api/proxy/hosts…` routes are gone (404). Use an API token (`Authorization: Bearer …`, an admin token) and the two calls:

```sh
H='Authorization: Bearer hpx_…'
# Which proxies exist, and their ids
curl -s -H "$H" https://hyperprox.example.com/api/proxy/instances
# Create: preview, read the plan, then apply it
curl -s -H "$H" -H 'Content-Type: application/json' https://hyperprox.example.com/api/proxy/instances/npm/preview \
  -d '{"action":"create","host":{"domains":["app.example.com"],"forwardScheme":"http","forwardHost":"192.0.2.10","forwardPort":8080}}'
#   -> {"success":true,"data":{"id":"<planId>","changes":[…],"consequences":[…],"warnings":[…],…}}
curl -s -H "$H" -X POST https://hyperprox.example.com/api/proxy/plans/<planId>/apply
#   -> {"success":true,"data":{"ok":true,"hostId":"42","mismatch":[],"message":"Done, and read back …"}}
# Update: send only what changes
curl -s -H "$H" -H 'Content-Type: application/json' https://hyperprox.example.com/api/proxy/instances/npm/preview \
  -d '{"action":"update","hostId":"42","host":{"forwardPort":8081}}'
# Enable, disable, delete: no host body
curl -s -H "$H" -H 'Content-Type: application/json' https://hyperprox.example.com/api/proxy/instances/npm/preview -d '{"action":"disable","hostId":"42"}'
```

- `host` fields: `domains` (array), `forwardScheme` (`http`|`https`), `forwardHost`, `forwardPort`, `enabled`, `websockets`, and for NPM `npm: { certificate_id (number or false), ssl_forced, block_exploits, http2_support, hsts_enabled, hsts_subdomains, caching_enabled, advanced_config }`. A create needs `domains`, `forwardHost` and `forwardPort`; an update takes any subset.
- Check `data.ok` on the apply, not only `success`: `success:true, ok:false` means the write was sent and the read-back did not match (`mismatch` says how), or a create failed part-way (`cleanup` holds a plan to remove what was made).
- A refusal is a 4xx with `error` in words: 400 bad input or nothing to change, 404 unknown instance or host, 409 read-only host, name clash or a host changed since the preview, 410 an expired or used plan, 422 a configuration the proxy rejected (HAProxy).

## Per kind

**Traefik.** Give HyperProx a file of its own inside the directory Traefik's file provider watches, for example `/etc/traefik/dynamic/hyperprox.yml`. HyperProx writes it whole, beside the target and then renamed over it, so Traefik never reads half a file. A file at that path that HyperProx did not write (it starts with a `# Managed by HyperProx` line) is never overwritten. Bring Your Own instances write it over SFTP: the SSH host key is learned and pinned when the instance is added, and a server that later offers another key is refused. A login that can write only that directory is enough (a sticky directory keeps other files safe). Managed instances write it through the container (`pct exec` on the node, with the node's vault-held login). The API can sit behind basic auth. Writes to one Traefik instance are serialised (one read-modify-write of the file at a time), and every key in HyperProx's file that it does not edit (other middlewares, `tls`, `tcp`, …) is kept. The SSH connection is pooled per instance and closed after a minute idle. If the SSH host or port changes, the key the new server offers is shown and nothing is saved until it is sent back as `ssh_host_key`.

**Managed Caddy and HAProxy.** Their APIs listen on `127.0.0.1` inside the container only (host networking; nothing is published), and HyperProx reaches them through the container: `pct exec` on the node with the node's vault-held login, then `curl` to loopback (instance setting `api_via: guest`). Headers (credentials included) and bodies travel as files, never on a command line, and redirects are never followed. HAProxy's Data Plane keeps its generated password as well. A Managed instance must name a container the Catalogue's rules allow: an LXC (not a VM) on that node, running, whose node has a login stored.

**Caddy.** HyperProx's routes go to the top of one server's route list (the first that listens on :80 or :443 unless you name one) and are addressed by `@id` afterwards. Run Caddy with `caddy run --resume`: changes made through the API are saved to `autosave.json`, and `--resume` loads them at start-up. Health says when `admin.config.persist` is off. Caddy's admin API has no login of its own; expose it only to HyperProx (or put it behind something that checks the basic credentials HyperProx can send).

**HAProxy.** A bad reload drops every frontend, so each change is one Data Plane transaction that is checked twice before HAProxy reloads: the transaction's whole configuration goes to `only_validate` (`haproxy -c`), and only then is it committed (Data Plane validates again). HyperProx then waits for the reload to report success and checks that every frontend that existed before still exists. A configuration HAProxy rejects is never committed and its transaction is deleted. If the reload fails or a frontend is missing after the commit, HyperProx posts the configuration from before the change back through the Data Plane, waits for that reload, checks the frontends again, and says in the error whether the rollback worked.

**Pangolin.** Enable the integration API (`flags.enable_integration_api: true`, port 3003) and create an organisation API key with the actions `getOrg`, `listSites`, `getSite`, `listResources`, `getResource`, `createResource`, `updateResource`, `deleteResource`, `listTargets`, `getTarget`, `createTarget`, `updateTarget`, `deleteTarget` (and domain listing). A Pangolin resource has one name, made of a subdomain and one of the organisation's domains, so a host here has exactly one domain. Targets go through the organisation's first site unless you name one. New resources keep Pangolin's own access defaults (its login in front, unless you change it in Pangolin).

## Routes and roles

| Route | Role |
|---|---|
| `GET /api/proxy/kinds`, `/instances`, `/hosts`, `/certificates`, `/stats`, `/instances/:id/{hosts,certificates,health}` | viewer (see below) |
| `POST/PUT/DELETE /api/proxy/instances…`, `POST /instances/:id/preview`, `POST /plans/:id/apply`, `POST /instances/:id/certificates` | admin |

Any other path under `/api/proxy` is admin until it is listed in `roles.ts`.

**What a viewer sees** (and operators): for hosts, names, target, enabled/online, read-only, and the certificate's name and expiry; for instances, id, kind, name, mode and status (no URL, settings, node or container); for certificates, names, expiry and issuer; for health, which checks passed. Never NPM's native host (its advanced configuration often carries upstream credentials), never a certificate's `meta` (NPM keeps DNS-challenge credentials there; admins do not get it either), and never a proxy's own error text: a failing instance is "not answering".

**Instance URLs.** A Bring Your Own instance may not point at a loopback or link-local address (or a name that resolves to one): HyperProx's own services and cloud metadata live there. Only a Managed instance, reached through its container, uses loopback. HyperProx never follows a redirect from a proxy, so a redirected NPM sign-in cannot carry the password elsewhere.

**Polling.** Host lists are cached per instance for 20 s and cleared by every write; instances are read in parallel and one that takes more than 8 s is shown as not answering while the rest of the table loads. The page polls only while its tab is visible. NPM tokens are reused across requests until shortly before they expire.

## Tests

- `test/proxy-contract.test.ts` runs one contract (`test/proxy-contract.ts`) against every provider on fixtures recorded from real servers (`test/fixtures/proxy`, addresses rewritten to 192.0.2.x): health, a hand-made host listed read-only, writes to it refused, create/update/disable/enable/delete previewed, applied and read back, a change made after the preview failing the apply, the hand-made host untouched at the end. Two NPM instances run it side by side.
- `test/proxy-providers.test.ts` covers each kind's own rules (HAProxy's validation order and its refusal path, Traefik's foreign file, Caddy's placement and persistence, Pangolin's one-name rule), instance validation, plan expiry and ownership, the Managed file transport in a real shell, and the certificate-inventory hook.
- `test/proxy-live.test.ts` runs the same contract against live servers, with traffic checked through each proxy. Opt-in: `HP_PROXY_LIVE=1 HP_PROXY_LIVE_CONFIG=/path/to/config.json`. The config (addresses and test credentials of throwaway servers) lives outside the repository. A second phase, `HP_PROXY_LIVE_PHASE=after-caddy-restart`, run after restarting the Caddy container, checks that a host HyperProx added survived the restart.

## Hooks for the integrator

- **AI wizard**: wired. `stepConfigureProxy` creates through `wizardCreateHost`, and `stepRequestSSL` requests through `wizardRequestCertificate` (with the Let's Encrypt email) and attaches with `wizardUpdateHost`, a patch of four options that keeps everything else. The wizard's own confirm step is the preview a person saw, so these run preview and apply back to back: same refusals, read-back and `proxy.host.*` audit entries, as the run's owner. The wizard still drives the Settings NPM only.
- **Catalogue**: `lib/proxy/managed-recipes.ts` has recipes for Managed Traefik, Caddy and HAProxy (`managedProxyRecipe`, `managedProxyFiles`) and `managedInstanceInput(...)`, which registers the installed proxy as a Managed instance.
- **Updates**: `proxyService().managedInstances()` lists Managed instances with their node, container and recipe.
