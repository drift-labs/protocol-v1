import {
	ClearingHouseUserConfig,
	getClearingHouseUser,
} from '../factory/clearingHouseUser';
import { UserRegistry } from '../userRegistry/userRegistry';
import { ClearingHouseUser } from '../clearingHouseUser';

export class ClearingHouseUserGroup {
	users = new Array<ClearingHouseUser>();
	seedMap = new Map<number, ClearingHouseUser>();
	nameMap = new Map<string, ClearingHouseUser>();

	public constructor(
		clearingHouseUserConfig: ClearingHouseUserConfig,
		userRegistry: UserRegistry
	) {
		for (const [seed, name] of userRegistry.getUserNames().entries()) {
			clearingHouseUserConfig.seed = seed;
			const clearingHouseUser = getClearingHouseUser(clearingHouseUserConfig);

			this.users.push(clearingHouseUser);
			this.seedMap.set(seed, clearingHouseUser);
			this.nameMap.set(name, clearingHouseUser);
		}
	}
}
