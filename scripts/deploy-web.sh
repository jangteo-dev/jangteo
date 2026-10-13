#!/usr/bin/env bash
# Build the web app and copy it into the live docroot. Files the ops service publishes next to the
# app are never overwritten, and old hashed assets stay so open tabs can still lazy-load them.
set -euo pipefail
cd "$(dirname "$0")/../web"
WEBROOT=${GYE_WEBROOT:-/srv/jangteo/current}
npm run build
rsync -a \
  --exclude deployment.json --exclude swap-stats.json --exclude points.json --exclude stats.json \
  --exclude market.json --exclude 'market/' --exclude routes.json --exclude withdrawals.json \
  --exclude orders.json --exclude 'insa-data/' --exclude stocks.json --exclude 'stocks/' \
  dist/ "$WEBROOT/"
chown -R www:www "$WEBROOT"
../scripts/publish-deployment.sh >/dev/null
echo "deployed to $WEBROOT"
