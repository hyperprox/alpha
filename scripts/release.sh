#!/usr/bin/env bash
# HyperProx — cut a release: bump the version, commit, tag (annotated, signed when you can), and publish it.
#
#   bash scripts/release.sh 0.3.0-alpha                 # prepare: bump, commit, tag; prints what to push
#   bash scripts/release.sh 0.3.0-alpha --push          # ...and push main + the tag, and make the GitHub release
#   bash scripts/release.sh 0.3.0-alpha --notes notes.md --sign --push
#   bash scripts/release.sh 0.3.0-alpha --dry-run       # show everything, change nothing
#
# Installs on the stable channel see the release on their Updates page (GitHub Releases, newest version first).
# See RELEASING.md for the whole process, and for the two kinds of note line the updater flags.
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "✗ $*" >&2; exit 1; }

VERSION="" NOTES="" SIGN=0 PUSH=0 DRY=0 REMOTE="${RELEASE_REMOTE:-origin}"
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="${2:-}"; shift 2;;
    --sign) SIGN=1; shift;;
    --push) PUSH=1; shift;;
    --dry-run) DRY=1; shift;;
    --remote) REMOTE="${2:-}"; shift 2;;
    -h|--help) usage; exit 0;;
    -*) die "Unknown option: $1 (try --help)";;
    *) [ -z "$VERSION" ] || die "One version, please."; VERSION="${1#v}"; shift;;
  esac
done
[ -n "$VERSION" ] || { usage; exit 1; }
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]] \
  || die "$VERSION is not a semantic version (MAJOR.MINOR.PATCH, optionally -alpha, -beta.1, ...)."
TAG="v$VERSION"

ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
[ "$(git symbolic-ref --short -q HEAD || true)" = main ] || die "Releases are cut from main."
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "The tree has local changes; commit or stash them first."
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "$TAG already exists."
if git remote get-url "$REMOTE" >/dev/null 2>&1; then
  git fetch --quiet --tags "$REMOTE" main || die "Could not fetch $REMOTE."
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "$REMOTE/main")" ] || die "main is not the same as $REMOTE/main; pull or push first."
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "$TAG already exists on $REMOTE."
fi

# The newest release tag so far, by semver (pre-releases rank below their release).
LAST="$(git tag --list 'v[0-9]*' | node -e '
  const re = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
  const cmp = (a, b) => { for (let i = 1; i <= 3; i++) { const d = +a[i] - +b[i]; if (d) return d }
    if (!a[4] || !b[4]) return a[4] ? -1 : b[4] ? 1 : 0
    const x = a[4].split("."), y = b[4].split(".")
    for (let i = 0; i < Math.max(x.length, y.length); i++) { if (x[i] === undefined) return -1; if (y[i] === undefined) return 1
      const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]); if (nx && ny && +x[i] !== +y[i]) return +x[i] - +y[i]
      if (nx !== ny) return nx ? -1 : 1; if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1 } return 0 }
  const tags = require("fs").readFileSync(0, "utf8").split("\n").map(t => re.exec(t.trim())).filter(Boolean).sort(cmp)
  const next = re.exec(process.argv[1])
  if (tags.length && cmp(next, tags[tags.length - 1]) <= 0) { console.error(`v${process.argv[1].slice(1)} is not newer than ${tags[tags.length - 1][0]}`); process.exit(3) }
  process.stdout.write(tags.length ? tags[tags.length - 1][0] : "")
' "$TAG")" || die "Pick a version newer than the newest release."

# Release notes: yours (--notes), or the commit subjects since the last release. Either way the database
# migrations this release adds are listed, so the updater (and a person reading it) can see them.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
NOTES_FILE="$TMP/notes.md"
RANGE="${LAST:+$LAST..}HEAD"
if [ -n "$NOTES" ]; then
  [ -f "$NOTES" ] || die "$NOTES does not exist."
  cp "$NOTES" "$NOTES_FILE"
else
  {
    echo "## What changed"; echo
    git log --no-merges --format='- %s' "$RANGE" | head -200
  } > "$NOTES_FILE"
fi
MIGRATIONS="$(git diff --name-only --diff-filter=A ${LAST:+"$LAST"} HEAD -- apps/api/prisma/migrations 2>/dev/null | grep '/migration.sql$' | cut -d/ -f5 || true)"
[ -n "$LAST" ] || MIGRATIONS=""
if [ -n "$MIGRATIONS" ] && ! grep -qi '^MIGRATION' "$NOTES_FILE"; then
  { echo; echo "MIGRATION: this release adds database migrations, applied during the update (a backup is taken first):"
    printf -- '- %s\n' $MIGRATIONS; } >> "$NOTES_FILE"
fi

echo "→ Release $TAG (previous: ${LAST:-none})"
echo "--- notes ----------------------------------------------------------------"
cat "$NOTES_FILE"
echo "--------------------------------------------------------------------------"
if [ "$DRY" = 1 ]; then echo "(dry run: nothing changed)"; exit 0; fi

# The one version for the whole product (lib/version.ts, next.config.js), and the two apps' own, kept in step.
for f in package.json apps/api/package.json apps/frontend/package.json; do
  [ -f "$f" ] || continue
  sed -i -E "0,/\"version\"([[:space:]]*):([[:space:]]*)\"[^\"]*\"/s//\"version\"\1:\2\"$VERSION\"/" "$f"
  grep -q "\"$VERSION\"" "$f" || die "Could not set the version in $f."
done
git add package.json apps/api/package.json apps/frontend/package.json
git commit --quiet -m "Release $TAG"

SIGN_ARG=(-a)
if [ "$SIGN" = 1 ] || [ "$(git config --bool tag.gpgSign || true)" = true ]; then SIGN_ARG=(-s); fi
git tag "${SIGN_ARG[@]}" "$TAG" -F "$NOTES_FILE"
echo "✓ Committed and tagged $TAG ($(git rev-parse --short=7 HEAD))$([ "${SIGN_ARG[0]}" = -s ] && echo ', signed')"

PRE=""; [[ "$VERSION" == *-* ]] && PRE="--prerelease"
if [ "$PUSH" = 1 ]; then
  git push "$REMOTE" main "$TAG"
  if command -v gh >/dev/null 2>&1; then
    gh release create "$TAG" --title "$TAG" --notes-file "$NOTES_FILE" $PRE --verify-tag
    echo "✓ GitHub release $TAG published"
  else
    echo "! gh is not installed: create the release on GitHub from the tag $TAG and paste the notes above."
  fi
else
  cp "$NOTES_FILE" "$ROOT/.release-notes-$TAG.md"
  echo "Next:"
  echo "  git push $REMOTE main $TAG"
  echo "  gh release create $TAG --title $TAG --notes-file .release-notes-$TAG.md $PRE --verify-tag"
fi
