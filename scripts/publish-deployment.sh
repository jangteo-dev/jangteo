#!/usr/bin/env bash
# Merge every deployment file into the single deployment.json the web app reads, and publish it.
set -euo pipefail
SECRETS="$(cd "$(dirname "$0")/.." && pwd)/keys"
cd "$(dirname "$0")/../contracts/deployments"
WEBROOT=${GYE_WEBROOT:-/srv/jangteo/current}
OUT=../../web/public/deployment.json
jq -s '.[0]
  + (if .[1] then {sangjang: .[1].market} else {} end)
  + (if .[2] then {cheongyak: .[2].cheongyak, tokenFactory: .[2].tokenFactory, yut: .[2].yut} else {} end)
  + (if .[3] then {cheongyakV2: .[3].cheongyakV2, swapFactory: .[3].swapFactory, swapRouter: .[3].swapRouter} else {} end)
  + (if .[4] then {jangoe: .[4].jangoe} else {} end)
  + (if .[5] then {pump: .[5].pump, pumpRouter: .[5].pumpRouter} else {} end)
  + (if .[6] then {bridge: .[6].bridge} else {} end)
  + (if .[7] then {aggregator: .[7].aggregator} else {} end)
  + (if .[8] then {withdraw: .[8].withdraw} else {} end)
  + (if .[9] then {fastExit: .[9].fastExit} else {} end)
  + (if .[10] then {fastVault: .[10].fastVault} else {} end)
  + (if .[11] then {daily: .[11].daily} else {} end)
  + (if .[12] then {orders: .[12].orders} else {} end)
  + (if .[13] then {insaFactory: .[13].insaFactory, insaMarket: .[13].insaMarket} else {} end)
  + (if .[14] then {tal: .[14].tal} else {} end)
  + (if .[15] then {pump: .[15].pump, pumpRouter: .[15].pumpRouter, pumpV1: .[5].pump, pumpRouterV1: .[5].pumpRouter} else {} end)
  + (if .[16] then {invite: .[16].invite} else {} end)' \
  91342.json <(cat 91342.sangjang.json 2>/dev/null || echo null) <(cat 91342.stalls.json 2>/dev/null || echo null) \
  <(cat 91342.launchpad.json 2>/dev/null || echo null) <(cat 91342.jangoe.json 2>/dev/null || echo null) \
  <(cat 91342.pump.json 2>/dev/null || echo null) <(cat 11155111.bridge.json 2>/dev/null || echo null) \
  <(cat 91342.aggregator.json 2>/dev/null || echo null) <(cat 91342.withdraw.json 2>/dev/null || echo null) \
  <(cat 91342.fastexit.json 2>/dev/null || echo null) <(cat 11155111.fastvault.json 2>/dev/null || echo null) \
  <(cat 91342.daily.json 2>/dev/null || echo null) <(cat 91342.orders.json 2>/dev/null || echo null) \
  <(cat 91342.insa.json 2>/dev/null || echo null) <(cat 91342.tal.json 2>/dev/null || echo null) \
  <(cat 91342.pump2.json 2>/dev/null || echo null) <(cat 91342.invite.json 2>/dev/null || echo null) > "$OUT"
# The 윷 house player (ops `yut:bot`) is shown by name in the UI.
HOUSE=$(grep -s '^GIWA_FARM2_ADDRESS=' "$SECRETS/wallets.env" | cut -d= -f2 || true)
if [[ -n "$HOUSE" ]]; then tmp=$(mktemp); jq --arg h "$HOUSE" '. + {yutHouse: $h}' "$OUT" > "$tmp" && mv "$tmp" "$OUT"; fi
if [[ -d $WEBROOT ]]; then cp "$OUT" "$WEBROOT/deployment.json"; chown www:www "$WEBROOT/deployment.json" 2>/dev/null || true; fi
cat "$OUT"
