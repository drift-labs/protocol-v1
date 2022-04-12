import { UserRegistryAccount } from '../types';
import { decodeName } from './userName';

export class UserRegistry {
	account: UserRegistryAccount;
	names: string[];

	public constructor(userRegistryAccount: UserRegistryAccount) {
		this.account = userRegistryAccount;
		this.names = this.account.names.map((name) => decodeName(name));
	}

	public nextAvailableSeed(): number | undefined {
		return this.names.findIndex((name) => name !== '');
	}

	/**
	 * Gives the set of names that have been registered by authority. The index of the name is the corresponding seed
	 * for a UserAccount
	 */
	public getUserNames(): string[] {
		return this.names.filter((name) => name !== '');
	}
}
