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
}
