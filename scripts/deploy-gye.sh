#!/usr/bin/env bash
# Deploy Gye to GIWA Sepolia and publish the addresses to the web app.
# Idempotent: refuses to redeploy if contracts/deployments/91342.json already exists (pass --force to override).
set -euo pipefail
cd "$(dirname "$0")/../contracts"
OUT=deployments/91342.json
WEBROOT=${GYE_WEBROOT:-/srv/jangteo/current}
if [[ -f $OUT && "${1:-}" != "--force" ]]; then echo "already deployed: $(jq -r .factory $OUT)"; exit 0; fi
set -a; . ../keys/keeper.env; set +a
GYE_MIN_ROUND=${GYE_MIN_ROUND:-600} forge script script/Deploy.s.sol \
  --rpc-url giwa_sepolia --broadcast --slow --private-key "$GIWA_DEPLOYER_KEY" 2>&1 | grep -E 'GyeFactory|GyeReputation|DojangGate|tKRW|ONCHAIN|Error' || true
test -f $OUT || { echo "deployment file missing — broadcast failed"; exit 1; }
for c in GyeFactory GyeReputation GyeWon DojangGate; do
  a=$(jq -r ".$(echo $c | sed 's/GyeFactory/factory/;s/GyeReputation/reputation/;s/GyeWon/tkrw/;s/DojangGate/gate/')" $OUT)
  forge verify-contract --chain 91342 --verifier blockscout --verifier-url https://sepolia-explorer.giwa.io/api/ "$a" "$c" >/dev/null 2>&1 && echo "verified $c" || echo "verify skipped $c"
done
# The circle template is deployed by the factory's constructor, so verify it separately.
forge verify-contract --chain 91342 --verifier blockscout --verifier-url https://sepolia-explorer.giwa.io/api/ "$(jq -r .implementation $OUT)" GyeCircle >/dev/null 2>&1 && echo "verified GyeCircle" || echo "verify skipped GyeCircle"
"$(dirname "$0")/publish-deployment.sh" >/dev/null
cat $OUT
