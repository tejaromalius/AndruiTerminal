#!/usr/bin/env bash
# bump-version.sh X.Y.Z - Set the AndruiTerminal version everywhere.
#
# Updates: [workspace.package] version in Cargo.toml (inherited by every crate, the
# frontend build and the .deb), Cargo.lock and web/package.json(+lock).
# The Android helper APK keeps its own version (helper-apk/AndroidManifest.xml).

set -euo pipefail

NEW="${1:-}"
if [[ ! "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: $0 X.Y.Z   (semantic version, e.g. 1.2.0)" >&2
  exit 1
fi

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OLD="$(sed -n '/^\[workspace\.package\]/,/^\[/s/^version *= *"\(.*\)"/\1/p' Cargo.toml)"
if [[ -z "$OLD" ]]; then
  echo "ERROR: no [workspace.package] version in Cargo.toml" >&2
  exit 1
fi
if [[ "$NEW" == "$OLD" ]] || [[ "$(printf '%s\n%s\n' "$OLD" "$NEW" | sort -V | tail -1)" != "$NEW" ]]; then
  echo "ERROR: new version $NEW must be greater than the current $OLD" >&2
  exit 1
fi

sed -i "/^\[workspace\.package\]/,/^\[/s/^version *= *\".*\"/version = \"$NEW\"/" Cargo.toml
cargo update --workspace --offline --quiet
(cd web && npm version "$NEW" --no-git-tag-version --allow-same-version >/dev/null)

echo "Version $OLD -> $NEW. Rebuild with scripts/build-deb.sh."
