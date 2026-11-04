# Proxies

HyperProx drives reverse proxies through one interface (`apps/api/src/lib/proxy`). The Proxy page, the AI wizard's proxy step and the certificate inventory all go through it, so a second Nginx Proxy Manager, or a Caddy beside an NPM, is just another instance.

| Kind | How HyperProx talks to it | Hosts it treats as its own | "Disabled" means | Certificates |
|---|---|---|---|---|
| Nginx Proxy Manager | NPM's API (`/api`), an email and password | Every host (NPM is driven whole, as it always was) | NPM stops serving the host | Listed and requested through NPM |
| Traefik | Reads `/api/http/routers` and `/services`; writes **one file of its own** for the file provider | Routers in that file (`hpx-…`) | The router gets the `hpx-disabled` allow-list: Traefik answers 403 | Traefik's own (a certificate resolver, if set) |
| Caddy | The admin API (`/config/`, `/id/`) | Routes with an `@id` of `hpx-…` | The route answers 503 | Caddy's automatic HTTPS |
| HAProxy | The Data Plane API v3, in transactions | Backends `hpx_…` and their `use_backend` rule in one frontend | The server goes into maintenance: 503 | Listed from Data Plane storage |
| Pangolin | The integration API (`/v1`) with an organisation key | Resources whose niceId is `hpx-…` | Pangolin stops serving the resource | Pangolin's own |

Anything else on a proxy (Traefik labels or other files, a hand-written Caddy route, an HAProxy rule pointing at another backend, a Pangolin resource made in its UI) is **shown read-only** with the instance that owns it, and HyperProx refuses every write to it before the proxy is asked. The one exception is NPM: HyperProx has always edited every NPM host, and still does.

## Instances

- **Several at once.** Add as many instances as you like, two of the same kind included. Every host in the table names its instance.
- **The Settings NPM.** The NPM login in Settings → Proxy is the instance `npm`. It keeps working unchanged; it is changed and removed in Settings, not on the Proxy page.
- **Bring Your Own or Managed.** Bring Your Own is a proxy you run: you give HyperProx a login. Managed is one the Catalogue installed into a container HyperProx knows (node and container id are recorded), so Updates can update it and the Traefik file can be written through the container instead of SSH.
- **Secrets** (passwords, keys, API keys) are kept in the vault, one item per instance (`hyperprox:proxy-instance/<id>`). The `ProxyInstance` table holds only names, URLs and options. Forgetting an instance removes its vault item and changes nothing on the proxy.

## Writes: preview, apply, read back

Every change is two calls:

1. `POST /api/proxy/instances/:id/preview` with `{ action, hostId?, host? }` (`create`, `update`, `delete`, `enable`, `disable`). HyperProx reads the proxy, refuses what must not happen (a read-only host, a name another host on that proxy already serves), and returns a plan: each change and what it means, in words. A name that another instance also serves is a warning, not a refusal.
2. `POST /api/proxy/plans/:planId/apply`. Only the plan's id is accepted, only by whoever previewed it, once, within ten minutes. HyperProx reads the host again first: if it changed since the preview, nothing is done. After the write it reads the proxy again and compares what is there with the plan. A proxy that says OK while the host is not what was planned is reported as a failure.

Each apply is written to the audit log (`proxy.host.<action>`), with who, the names and whether the read-back matched; never a credential.

## Per kind

**Traefik.** Give HyperProx a file of its own inside the directory Traefik's file provider watches, for example `/etc/traefik/dynamic/hyperprox.yml`. HyperProx writes it whole, beside the target and then renamed over it, so Traefik never reads half a file. A file at that path that HyperProx did not write (it starts with a `# Managed by HyperProx` line) is never overwritten. Bring Your Own instances write it over SFTP: the SSH host key is learned and pinned when the instance is added, and a server that later offers another key is refused. A login that can write only that directory is enough (a sticky directory keeps other files safe). Managed instances write it through the container (`pct exec` on the node, with the node's vault-held login). The API can sit behind basic auth.

**Caddy.** HyperProx's routes go to the top of one server's route list (the first that listens on :80 or :443 unless you name one) and are addressed by `@id` afterwards. Run Caddy with `caddy run --resume`: changes made through the API are saved to `autosave.json`, and `--resume` loads them at start-up. Health says when `admin.config.persist` is off. Caddy's admin API has no login of its own; expose it only to HyperProx (or put it behind something that checks the basic credentials HyperProx can send).

**HAProxy.** A bad reload drops every frontend, so each change is one Data Plane transaction that is checked twice before HAProxy reloads: the transaction's whole configuration goes to `only_validate` (`haproxy -c`), and only then is it committed (Data Plane validates again). HyperProx then waits for the reload to report success and checks that every frontend that existed before still exists. A configuration HAProxy rejects is never committed and its transaction is deleted.

**Pangolin.** Enable the integration API (`flags.enable_integration_api: true`, port 3003) and create an organisation API key with the actions `getOrg`, `listSites`, `getSite`, `listResources`, `getResource`, `createResource`, `updateResource`, `deleteResource`, `listTargets`, `getTarget`, `createTarget`, `updateTarget`, `deleteTarget` (and domain listing). A Pangolin resource has one name, made of a subdomain and one of the organisation's domains, so a host here has exactly one domain. Targets go through the organisation's first site unless you name one. New resources keep Pangolin's own access defaults (its login in front, unless you change it in Pangolin).

## Routes and roles

| Route | Role |
|---|---|
| `GET /api/proxy/kinds`, `/instances`, `/hosts`, `/certificates`, `/stats`, `/instances/:id/{hosts,certificates,health}` | viewer (instance settings are only returned to admins) |
| `POST/PUT/DELETE /api/proxy/instances…`, `POST /instances/:id/preview`, `POST /plans/:id/apply`, `POST /instances/:id/certificates` | admin |

Any other path under `/api/proxy` is admin until it is listed in `roles.ts`.

## Tests

- `test/proxy-contract.test.ts` runs one contract (`test/proxy-contract.ts`) against every provider on fixtures recorded from real servers (`test/fixtures/proxy`, addresses rewritten to 192.0.2.x): health, a hand-made host listed read-only, writes to it refused, create/update/disable/enable/delete previewed, applied and read back, a change made after the preview failing the apply, the hand-made host untouched at the end. Two NPM instances run it side by side.
- `test/proxy-providers.test.ts` covers each kind's own rules (HAProxy's validation order and its refusal path, Traefik's foreign file, Caddy's placement and persistence, Pangolin's one-name rule), instance validation, plan expiry and ownership, the Managed file transport in a real shell, and the certificate-inventory hook.
- `test/proxy-live.test.ts` runs the same contract against live servers, with traffic checked through each proxy. Opt-in: `HP_PROXY_LIVE=1 HP_PROXY_LIVE_CONFIG=/path/to/config.json`. The config (addresses and test credentials of throwaway servers) lives outside the repository. A second phase, `HP_PROXY_LIVE_PHASE=after-caddy-restart`, run after restarting the Caddy container, checks that a host HyperProx added survived the restart.

## Hooks for the integrator

- **AI wizard** (`wizard-executor.ts`, `stepConfigureProxy`): replace the direct `npm.createProxyHost` with `wizardCreateHost(spec, actor, instanceId?)` from `lib/proxy`, which creates the host through the same preview → apply → read-back path. `stepRequestSSL` can use `proxyService().requestCertificate(...)`.
- **Catalogue**: `lib/proxy/managed-recipes.ts` has recipes for Managed Traefik, Caddy and HAProxy (`managedProxyRecipe`, `managedProxyFiles`) and `managedInstanceInput(...)`, which registers the installed proxy as a Managed instance.
- **Updates**: `proxyService().managedInstances()` lists Managed instances with their node, container and recipe.
