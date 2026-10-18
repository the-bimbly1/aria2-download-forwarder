#!/usr/bin/env bash
#
# package.sh: validate the project and build the extension zip.
#
# Output: dist/aria2-download-forwarder-<version>.zip, with the version read
# from extension/manifest.json. The zip has manifest.json at its root, which
# is the layout browsers expect for "Load unpacked" after unzipping, and what
# the Chrome Web Store expects too.
#
# Used by CI and handy locally. Needs node and python3; nothing else.
#
set -euo pipefail
# Always run from the repo root, wherever the script was called from.
cd "$(dirname "$0")/.."

# Basic checks first, so we never package something that won't load.
for f in extension/*.js; do node --check "$f"; done
python3 -m json.tool extension/manifest.json >/dev/null
python3 -m py_compile helper/app.py && rm -rf helper/__pycache__
VERSION=$(python3 -c 'import json;print(json.load(open("extension/manifest.json"))["version"])')
mkdir -p dist
OUT="dist/aria2-download-forwarder-${VERSION}.zip"
rm -f "$OUT"
# Python's zipfile instead of `zip`, which isn't installed everywhere.
python3 - "$OUT" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk("extension"):
        for f in sorted(files):
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, "extension"))
PY
echo "Built $OUT"
