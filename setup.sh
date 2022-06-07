yarn &&
cd sdk/ && yarn && yarn build && 
cd .. &&
solana config set -u l &&
anchor build &&
bash stress/run_local_sim.sh ../sim-results/sim-solhist/chPrePeg_1000.0