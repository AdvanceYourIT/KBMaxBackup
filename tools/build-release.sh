#!/usr/bin/env bash
# Builds releases/KBMax-Backup-v<version>.zip from the committed files: unzip it, then load the folder
# in edge://extensions (Developer mode > Load unpacked). Needs git and zip. Run from anywhere in the repository.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' manifest.json | head -1)
[ -n "$version" ] || { echo "No version found in manifest.json" >&2; exit 1; }
name="KBMax-Backup-v$version"
out="releases/$name.zip"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/$name" releases

# Committed files only, without the release tooling itself.
git archive HEAD | tar -x -C "$work/$name"
rm -rf "$work/$name/releases" "$work/$name/tools"

cat > "$work/$name/INSTALL.txt" <<TXT
KBMax Backup v$version - installation
=====================================
1. Unzip this archive (keep the folder; the extension runs from it).
2. Open edge://extensions (or chrome://extensions) and enable "Developer mode".
3. Click "Load unpacked" and select this folder (the one that contains manifest.json).
4. Log in to KBMax and open the extension from the toolbar.

README.md explains everything: backups, import, upload to Azure DevOps / GitHub and incremental sync.
After an update: replace the folder and click "Reload" on the extension in edge://extensions.
TXT

rm -f "$out"
(cd "$work" && zip -qr -X "$OLDPWD/$out" "$name")
echo "Built $out ($(du -h "$out" | cut -f1))"
