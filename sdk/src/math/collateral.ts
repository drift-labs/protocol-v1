import { MarketsAccount, StateAccount } from '../types';
import { Connection } from '@solana/web3.js';

/**
 * Client collateral is represented by the balance of the collateral wallet, as specified in the state, minus the sum of
 * each markets undistributed fees.
 *
 * @param connection
 * @param state
 * @param marketsAccount
 * @returns Precision : QUOTE_ASSET_PRECISION
 */
export async function calculateUserCollateralSize(
	connection: Connection,
	state: StateAccount,
	marketsAccount: MarketsAccount
): Promise<BN> {
	const collateralVaultPublicKey = state.collateralVault;
	const collateralVaultAmount = new BN(
		(
			await connection.getTokenAccountBalance(collateralVaultPublicKey)
		).value.amount
	);
	return marketsAccount.markets.reduce((collateralVaultAmount, market) => {
		return collateralVaultAmount.sub(market.amm.totalFee);
	}, collateralVaultAmount);
}
