import * as anchor from '@project-serum/anchor';
import { BN } from '../sdk';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Admin, UserRegistryAccount } from '../sdk/src';

import { mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { decodeName, encodeName } from '../sdk/src/userName';

describe('delete user', () => {
	const provider = anchor.Provider.local();
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
			chProgram.programId
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

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
});
