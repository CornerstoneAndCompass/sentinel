#!/bin/sh
# Assemble the deployable front end.
#
# Cloudflare Pages uploads whatever directory you point it at, so deploying the
# repo root would publish worker/src, .git and .claude as fetchable static
# files. The app is these five files and nothing else.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
cp index.html globe.html sw.js manifest.webmanifest icon.svg icon-maskable.svg robots.txt _headers dist/
echo "dist/ ready — $(ls dist | wc -l | tr -d ' ') files, $(du -sh dist | cut -f1)"
