(
    sleep 1.5 # wait for validator to be up and running
    echo "running tests..."
    solana-keygen new -o owner.json --silent -f &&
    solana airdrop 1000 ./owner.json && 
    ANCHOR_WALLET=owner.json npx ts-node ./stress/simulate.ts 
) & (
    solana-test-validator -r \
    --bpf-program ./program-keys/clearing_house-keypair.json ./target/deploy/clearing_house.so \
    --bpf-program ./program-keys/pyth-keypair.json ./target/deploy/pyth.so \
    --bpf-program ./program-keys/mock_usdc_faucet-keypair.json ./target/deploy/mock_usdc_faucet.so >node_log.txt 2>&1
)