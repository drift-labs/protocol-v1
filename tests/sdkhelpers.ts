import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, squareRootBN } from '../sdk';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	MARK_PRICE_PRECISION,
	calculateMarkPrice,
	calculateTradeSlippage,
	ClearingHouseUser,
	PositionDirection,
	AMM_RESERVE_PRECISION,
	QUOTE_PRECISION,
	MAX_LEVERAGE,
	convertToNumber,
	squareRootBN,
	cubicRootBN,
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import {
	mockUSDCMint,
	mockUserUSDCAccount,
	mintToInsuranceFund,
	mockOracle,
	setFeedPrice,
} from './testHelpers';

const calculateTradeAmount = (amountOfCollateral: BN) => {
	const ONE_MANTISSA = new BN(100000);
	const fee = ONE_MANTISSA.div(new BN(1000));
	const tradeAmount = amountOfCollateral
		// .mul(MAX_LEVERAGE)
		.mul(ONE_MANTISSA.sub(MAX_LEVERAGE.mul(fee)))
		.div(ONE_MANTISSA);
	return tradeAmount;
};

describe('squol', () => {
	const provider = anchor.Provider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let userAccountPublicKey: PublicKey;
	let userAccount: ClearingHouseUser;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x^2 * y
	// const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetAmount = new anchor.BN(1 * 10 ** 2).mul(
		new BN(AMM_RESERVE_PRECISION)
	);
	const ammInitialBaseAssetAmount = new anchor.BN(1 * 10 ** 2).mul(
		new BN(AMM_RESERVE_PRECISION)
	);
	//.div(AMM_RESERVE_PRECISION) //.mul(AMM_RESERVE_PRECISION);

	const usdcAmount = new BN(10 * 10 ** 6);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		userAccount = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await userAccount.unsubscribe();
	});

	it('Initialize State', async () => {
		const test = new BN(125);
		const p1 = new BN(1);
		console.log(test.toNumber());
		console.log('sqrt:', squareRootBN(test, p1).toNumber());
		console.log('cbrt:', cubicRootBN(test, p1).toNumber());

		const test2 = new BN(125).mul(AMM_RESERVE_PRECISION);
		const p2 = new BN(AMM_RESERVE_PRECISION);
		console.log(test.toNumber(), 'with AMM_RESERVE_PRECISION');
		console.log(
			'sqrt:',
			squareRootBN(test2, p2).toNumber() / AMM_RESERVE_PRECISION.toNumber()
		);
		console.log(
			'cbrt:',
			cubicRootBN(test2, p2).toNumber() / AMM_RESERVE_PRECISION.toNumber()
		);
	});
});
