#!/usr/bin/env sh
set -eu

mkdir -p public
cp index.html styles.css app.js runtime-config.js .nojekyll public/
