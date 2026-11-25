#!/bin/zsh
set -u
cd -- "${0:A:h}" || exit 1
fail() { print -r -- "$1"; print -r -- 'Press Return to close.'; read -r; exit 1; }
command -v node >/dev/null 2>&1 || fail 'Node.js 24 LTS is required. Install it from https://nodejs.org/ and open this file again.'
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)' || fail 'Use Node.js 24 LTS for this app.'
command -v npm >/dev/null 2>&1 || fail 'npm was not found. Install Node.js 24 LTS including npm.'
if [[ ! -d node_modules ]]; then
  print -r -- 'Installing local app dependencies (first launch requires internet)...'
  npm ci || fail 'Dependency installation failed. Your saved notes were not removed.'
fi
print -r -- 'Starting メモパレ. Keep this terminal open. Stop with Control-C.'
node server.mjs
result=$?
if (( result != 0 )); then fail 'The service stopped with an error. Review the message above; saved notes are kept in the data folder.'; fi
