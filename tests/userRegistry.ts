import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import {
	Admin,
	BN,
	UserRegistryAccount,
	getUserAccountPublicKey,
	UserAccount,
} from '../sdk/src';

import { mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { decodeName, encodeName } from '../sdk/src/userName';
import { getUserOrdersAccountPublicKey, UserOrdersAccount, ZERO } from '../sdk';

describe('user registry', () => {
	const provider = anchor.Provider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let usdcMint;
	let userUSDCAccount;

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
		await clearingHouse.subscribe(['depositHistoryAccount']);

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('fail init user registry', async () => {
		const invalidName = Array(...Buffer.alloc(32).fill(' '));
		try {
			await clearingHouse.initializeUserRegistryAccount(invalidName);
		} catch (e) {
			return;
		}
		assert(false);
	});

	it('init user registry', async () => {
		const name = 'crisp';
		const encodedName = encodeName(name);
		await clearingHouse.initializeUserRegistryAccount(encodedName);

		const registry = (await clearingHouse.program.account.userRegistry.fetch(
			await clearingHouse.getUserRegistryAccountPublicKey()
		)) as UserRegistryAccount;

		assert(registry.authority.equals(provider.wallet.publicKey));
		const decodedName = decodeName(registry.names[0]);
		assert(name === decodedName);
	});

	it('add user', async () => {
		const name = 'crisp1';
		const encodedName = encodeName(name);
		const seed = 1;
		await clearingHouse.addUser(seed, encodedName);

		const registry = (await clearingHouse.program.account.userRegistry.fetch(
			await clearingHouse.getUserRegistryAccountPublicKey()
		)) as UserRegistryAccount;

		assert(registry.authority.equals(provider.wallet.publicKey));
		const decodedName = decodeName(registry.names[1]);
		assert(name === decodedName);

		const secondUserAccountPublicKey = await getUserAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			seed
		);

		const secondUserAccount = (await clearingHouse.program.account.user.fetch(
			secondUserAccountPublicKey
		)) as UserAccount;
		assert(secondUserAccount.seed === 1);

		const secondUserOrdersAccountPublicKey =
			await getUserOrdersAccountPublicKey(
				clearingHouse.program.programId,
				secondUserAccountPublicKey
			);

		const secondUserOrdersAccount =
			(await clearingHouse.program.account.userOrders.fetch(
				secondUserOrdersAccountPublicKey
			)) as UserOrdersAccount;

		assert(secondUserOrdersAccount !== undefined);
	});

	it('fail add user', async () => {
		const name = 'crisp1';
		const encodedName = encodeName(name);
		const seed = 1;
		try {
			await clearingHouse.addUser(seed, encodedName);
		} catch (e) {
			return;
		}
		assert(false);
	});

	it('update user name', async () => {
		const name = 'lil perp';
		const encodedName = encodeName(name);
		const seed = 1;
		await clearingHouse.updateUserName(seed, encodedName);

		const registry = (await clearingHouse.program.account.userRegistry.fetch(
			await clearingHouse.getUserRegistryAccountPublicKey()
		)) as UserRegistryAccount;

		const decodedName = decodeName(registry.names[1]);
		assert(name === decodedName);
	});

	it('transfer collateral', async () => {
		const toUserAccountPublicKey = await getUserAccountPublicKey(
			clearingHouse.program.programId,
			provider.wallet.publicKey,
			1
		);

		await clearingHouse.transferCollateral(usdcAmount, toUserAccountPublicKey);

		const toUserAccount = (await clearingHouse.program.account.user.fetch(
			toUserAccountPublicKey
		)) as UserAccount;

		assert(toUserAccount.collateral.eq(usdcAmount));
		assert(toUserAccount.cumulativeDeposits.eq(usdcAmount));

		const fromUserAccount = (await clearingHouse.program.account.user.fetch(
			await clearingHouse.getUserAccountPublicKey()
		)) as UserAccount;

		assert(fromUserAccount.collateral.eq(ZERO));
		assert(fromUserAccount.cumulativeDeposits.eq(ZERO));

		const depositsHistory = clearingHouse.getDepositHistoryAccount();

		const transferOutRecord = depositsHistory.depositRecords[1];
		assert(transferOutRecord.direction.hasOwnProperty('transferOut'));
		assert(transferOutRecord.userAuthority.equals(provider.wallet.publicKey));
		assert(
			transferOutRecord.user.equals(
				await clearingHouse.getUserAccountPublicKey()
			)
		);
		assert(transferOutRecord.collateralBefore.eq(usdcAmount));
		assert(transferOutRecord.cumulativeDepositsBefore.eq(usdcAmount));
		assert(transferOutRecord.amount.eq(usdcAmount));

		const transferInRecord = depositsHistory.depositRecords[2];
		assert(transferInRecord.direction.hasOwnProperty('transferIn'));
		assert(transferInRecord.userAuthority.equals(provider.wallet.publicKey));
		assert(transferInRecord.user.equals(toUserAccountPublicKey));
		assert(transferInRecord.collateralBefore.eq(ZERO));
		assert(transferInRecord.cumulativeDepositsBefore.eq(ZERO));
		assert(transferOutRecord.amount.eq(usdcAmount));
	});
});
