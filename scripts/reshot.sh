#!/bin/bash
# DEV: rebuild renderer, reload the running app, composite on dark, screenshot.
cd "$(dirname "$0")/.." || exit 1
npx vite build --config vite.config.mts >/dev/null 2>&1 || { echo "vite build failed"; exit 1; }
node scripts/drive.mjs js "location.reload();'ok'" >/dev/null
sleep ${RELOAD_WAIT:-2}
node scripts/drive.mjs js "document.body.style.background='#0C0A09';'ok'" >/dev/null
[ -n "$1" ] && node scripts/drive.mjs js "$1" >/dev/null
sleep ${SHOT_WAIT:-0.8}
node scripts/drive.mjs shot "${OUT:-$TEMP/shot.png}"
