(
    sleep 1.5 # wait for validator to be up and running
    echo "running tests..."
    solana-keygen new -o owner.json --silent -f &&
    solana airdrop 1000 ./owner.json && 
    ANCHOR_WALLET=owner.json npx ts-node ./stress/v2stress.ts 
) & solana-test-validator -r --bpf-program ./target/deploy/clearing_house-keypair.json ./target/deploy/clearing_house.so --bpf-program ./target/deploy/pyth-keypair.json ./target/deploy/pyth.so --bpf-program ./target/deploy/mock_usdc_faucet-keypair.json ./target/deploy/mock_usdc_faucet.so >node_log.txt 2>&1