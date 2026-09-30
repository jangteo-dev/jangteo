#!/usr/bin/env bash
# End-to-end run against an anvil fork of GIWA Sepolia, using the real Dojang playground attester.
#   anvil --fork-url https://sepolia-rpc.giwa.io --chain-id 91342 &
#   GYE_DEPLOY_OUT=deployments/local-fork.json forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil0>
#   script/e2e-fork.sh
set -euo pipefail
R=${RPC:-http://127.0.0.1:8545}
D=${DEPLOY:-deployments/local-fork.json}
F=$(jq -r .factory $D); W=$(jq -r .tkrw $D); REP=$(jq -r .reputation $D)
EXT=0x63CCe2b569A7bC35895ee24306c1512fefc06121
KEYS=(
0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
0x92db14e403b83dfe3df233f83dfbc2d9c7ff9e8a0a8c5bfb4f1e1e7e0e0dc3a2 0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356
)
addr() { cast wallet address "$1"; }
tx() { local k=$1; shift; cast send --rpc-url $R --private-key $k "$@" >/dev/null; }
warp() { cast rpc --rpc-url $R evm_increaseTime $1 >/dev/null; cast rpc --rpc-url $R evm_mine >/dev/null; }
FEE=$(cast call $EXT 'fee()(uint256)' -r $R | cut -d' ' -f1)

echo "verify + fund ${#KEYS[@]} people"
for k in "${KEYS[@]}"; do
  a=$(addr $k)
  cast rpc --rpc-url $R anvil_setBalance $a 0x56BC75E2D63100000 >/dev/null
  tx $k $EXT 'payAndIssueEAS()' --value $FEE
  tx $k $W 'drip()'
  tx $k $W 'approve(address,uint256)' $F 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
done

NOW=$(cast block latest -f timestamp -r $R)
name() { cast --format-bytes32-string "$1"; }
create() { # key size mode round name
  tx $1 $F 'createCircle((address,uint128,uint8,uint8,uint32,uint16,uint64,bytes32),bool)' \
    "($W,100000000000000000000000,$2,$3,$4,$( [ $3 = 2 ] && echo 2000 || echo 0),$((NOW+259200)),$(name "$5"))" true
  cast call $F 'circles(uint256,uint256)(address[])' $(( $(cast call $F 'circleCount()(uint256)' -r $R | cut -d' ' -f1) - 1 )) 1 -r $R | tr -d '[]'
}
join() { local k=$1 c=$2; tx $k $W 'approve(address,uint256)' $c 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff; tx $k $c 'join()'; }
pay() { tx $1 $2 'contribute()'; }

echo "circle A: ordered, 6 seats, 2 rounds done, round 3 half paid"
A=$(create ${KEYS[0]} 6 0 3600 "Seongsu book club")
tx ${KEYS[0]} $W 'approve(address,uint256)' $A 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
for i in 1 2 3 4 5; do join ${KEYS[$i]} $A; done
for r in 1 2; do for i in 0 1 2 3 4 5; do pay ${KEYS[$i]} $A; done; warp 3700; tx ${KEYS[7]} $A 'settle()'; done
for i in 0 2 3; do pay ${KEYS[$i]} $A; done

echo "circle B: random, 8 seats, filling (3 of 8)"
B=$(create ${KEYS[6]} 8 1 86400 "Jeju trip 2027")
join ${KEYS[7]} $B

echo "circle C: auction, 4 seats, round 1 with a bid"
# people 0-7 already sit in A or B (newcomers may be in one circle at a time), so C gets fresh faces
FRESH=()
for n in 1 2 3 4; do
  k=$(cast wallet new --json | jq -r '.[0].private_key'); FRESH+=($k); a=$(addr $k)
  cast rpc --rpc-url $R anvil_setBalance $a 0x56BC75E2D63100000 >/dev/null
  tx $k $EXT 'payAndIssueEAS()' --value $FEE; tx $k $W 'drip()'
  tx $k $W 'approve(address,uint256)' $F 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
done
C=$(create ${FRESH[0]} 4 2 604800 "Hannam supper club")
tx ${FRESH[0]} $W 'approve(address,uint256)' $C 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
for n in 1 2 3; do join ${FRESH[$n]} $C; done
for n in 0 1 2; do pay ${FRESH[$n]} $C; done
tx ${FRESH[2]} $C 'bid(uint128)' 40000000000000000000000

echo "A=$A"; echo "B=$B"; echo "C=$C"
cast call $A 'round()(uint8)' -r $R
cast call $REP 'recordOf(address)((uint32,uint32,uint32,uint16,uint128,uint128,uint128,bytes32))' $(addr ${KEYS[0]}) -r $R
