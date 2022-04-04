import { ClearingHouseUser } from '../clearingHouseUser';
import { BulkAccountLoader } from './bulkAccountLoader';
import { PollingUserAccountSubscriber } from './pollingUserAccountSubscriber';
import { UserAccount, UserOrdersAccount } from '../types';
import { UserPublicKeys } from './types';
import { ProgramAccount } from '@project-serum/anchor';

/**
 * @param users
 * @param accountLoader
 */
export async function bulkPollingUserSubscribe(
	users: ClearingHouseUser[],
	accountLoader: BulkAccountLoader
): Promise<void> {
	if (users.length === 0) {
		await accountLoader.load();
		return;
	}

	// Fetch all the accounts first
	const program = users[0].clearingHouse.program;
	let userProgramAccounts: ProgramAccount[];
	let orderProgramAccounts: ProgramAccount[];
	await Promise.all([
		(async () => {
			userProgramAccounts = await program.account.user.all();
		})(),
		(async () => {
			orderProgramAccounts = await program.account.userOrders.all();
		})(),
	]);

	// Create a map of the authority to keys
	const authorityToSeedToKeys = new Map<string, Map<number, UserPublicKeys>>();
	const userToSeedAndAuthority = new Map<string, [number, string]>();
	for (const userProgramAccount of userProgramAccounts) {
		const userAccountPublicKey = userProgramAccount.publicKey;
		const userAccount = userProgramAccount.account as UserAccount;

		if (authorityToSeedToKeys.has(userAccount.authority.toString())) {
			const seedToKeys = authorityToSeedToKeys.get(
				userAccount.authority.toString()
			);
			seedToKeys.set(userAccount.seed, {
				user: userAccountPublicKey,
				userPositions: userAccount.positions,
				userOrders: undefined,
			});
		} else {
			const seedToKeys = new Map<number, UserPublicKeys>();
			seedToKeys.set(userAccount.seed, {
				user: userAccountPublicKey,
				userPositions: userAccount.positions,
				userOrders: undefined,
			});
			authorityToSeedToKeys.set(userAccount.authority.toString(), seedToKeys);
		}

		userToSeedAndAuthority.set(userAccountPublicKey.toString(), [
			userAccount.seed,
			userAccount.authority.toString(),
		]);
	}
	for (const orderProgramAccount of orderProgramAccounts) {
		const userOrderAccountPublicKey = orderProgramAccount.publicKey;
		const userOrderAccount = orderProgramAccount.account as UserOrdersAccount;

		const [seed, authority] = userToSeedAndAuthority.get(
			userOrderAccount.user.toString()
		);
		const userPublicKeys = authorityToSeedToKeys.get(authority).get(seed);
		userPublicKeys.userOrders = userOrderAccountPublicKey;
	}

	await Promise.all(
		users.map((user) => {
			// Pull the keys from the authority map so we can skip fetching them in addToAccountLoader
			const userPublicKeys = authorityToSeedToKeys
				.get(user.authority.toString())
				.get(user.seed);
			return (
				user.accountSubscriber as PollingUserAccountSubscriber
			).addToAccountLoader(userPublicKeys);
		})
	);

	await accountLoader.load();

	await Promise.all(
		users.map(async (user) => {
			return user.subscribe();
		})
	);
}
