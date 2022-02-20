import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { BN } from '../sdk';
import { assert } from 'chai';
import { Admin, ClearingHouse, MARK_PRICE_PRECISION, Wallet } from '../sdk/src';
import { Markets } from '../sdk/src/constants/markets';
import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { Keypair } from '@solana/web3.js';

describe('deposit for user', () => {
	const provider = anchor.Provider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let secondClearingHouse: ClearingHouse;
	const secondUserKeypair = new Keypair();

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

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
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			Markets[0].marketIndex,
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeUserAccount();

		secondClearingHouse = ClearingHouse.from(
			connection,
			new Wallet(secondUserKeypair),
			chProgram.programId,
			{
				commitment: 'confirmed',
			}
		);
		const txSig =
			await secondClearingHouse.program.provider.connection.requestAirdrop(
				secondUserKeypair.publicKey,
				10 ** 9
			);
		await secondClearingHouse.program.provider.connection.confirmTransaction(
			txSig
		);
		await secondClearingHouse.subscribe();

		await secondClearingHouse.initializeUserAccount();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await secondClearingHouse.unsubscribe();
	});

	it('successful deposit', async () => {
		const depositAmount = usdcAmount.div(new BN(2));
		await clearingHouse.depositCollateralForUser(
			depositAmount,
			userUSDCAccount.publicKey,
			await secondClearingHouse.getUserAccountPublicKey()
		);

		const secondUserAccount =
			await secondClearingHouse.program.account.user.fetch(
				await secondClearingHouse.getUserAccountPublicKey()
			);
		assert(secondUserAccount.collateral.eq(depositAmount));
	});
});
