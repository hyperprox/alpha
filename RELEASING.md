# Releasing HyperProx

HyperProx updates itself from the Updates page (see "Updating HyperProx" in the README). What an install is
offered depends on its channel:

| Channel | What it follows | Who it is for |
|---|---|---|
| **stable** (default) | GitHub Releases: the newest release whose version is newer than the installed one. With no releases, the newest `vX.Y.Z` tag. | Everyone |
| **alpha** | The newest commit on `main` | People who want every change as it lands |

So a release is three things: a version bump on `main`, an annotated tag `vX.Y.Z` on that commit, and a GitHub
Release made from the tag. `scripts/release.sh` does all three.

## Versions

- Semantic versions: `MAJOR.MINOR.PATCH`, with a pre-release part while HyperProx is in alpha (`0.3.0-alpha`,
  `0.3.0-alpha.2`). The tag is the version with a `v` in front.
- One version for the whole product: the root `package.json`. The script keeps `apps/api` and `apps/frontend` in
  step. The API and the web app read it at build time, with the commit and `git describe` (Settings, the sidebar
  footer and `/health` show all three).
- `main` keeps the version of the last release until the next one is cut. The stable channel compares versions,
  and for the same version it also checks whether the release has commits the install does not.

## Cutting a release

From a clean `main` that matches GitHub:

```bash
bash scripts/release.sh 0.3.0-alpha --dry-run   # see the version, the previous release and the notes
bash scripts/release.sh 0.3.0-alpha --push      # bump, commit, tag, push main and the tag, make the release
```

Without `--push` it stops after the local commit and tag and prints the two commands to publish them
(`git push origin main v0.3.0-alpha` and `gh release create ...`). `pnpm release 0.3.0-alpha` is the same script.

The script refuses when you are not on `main`, the tree has changes, `main` differs from GitHub, the tag exists,
or the version is not newer than the newest release.

### Release notes

`--notes notes.md` uses your notes. Without it, the notes are the commit subjects since the previous release.
Either way, when the release adds database migrations, a `MIGRATION:` paragraph listing them is added.

Two kinds of line are flagged on every install's Updates page before anyone installs:

- a line containing **`BREAKING`** (or "breaking change"), and commits written `feat!: ...` or with
  `BREAKING CHANGE` in their body;
- a line starting with **`MIGRATION:`** or `UPGRADE NOTE:`.

Mark a release as a pre-release on GitHub (the script does it for versions like `0.3.0-alpha`): installs with
"include pre-releases" turned off skip it.

Write them for the person updating: what changes for them and anything they have to do.

### Signed releases

`--sign` (or `git config tag.gpgSign true`) makes a signed tag with your GPG or SSH signing key instead of a plain
annotated one. Installs check a signed tag against the keys they trust (`HYPERPROX_UPDATE_TRUSTED_KEYS` in `.env`:
an SSH `allowed_signers` file or an armoured GPG key file). An install with **Require signed releases** turned on
refuses any release that is unsigned or does not verify, so once you start signing, keep signing. Configuring
trusted keys turns that requirement on for good (the page cannot turn it off), and automatic install is only
available on installs that have them. A signed tag names itself: a tag pushed under a different name from the
one it was made with is refused.

## After publishing

- On an install, Updates → HyperProx → **Check now** should offer the release on the stable channel.
- The GitHub release page is what the stable channel reads: a release left as a draft is not offered.
- A bad release is fixed forward: cut the next patch version. Do not move or delete a published tag — installs
  pin the exact commit they were offered, and refuse a tag that has moved.
