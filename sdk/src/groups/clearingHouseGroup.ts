import { UserRegistry } from '../userRegistry/userRegistry';
import { ClearingHouse } from '../clearingHouse';
import {
	ClearingHouseConfig,
	getClearingHouse,
} from '../factory/clearingHouse';

export class ClearingHouseGroup {
	clearingHouses = new Array<ClearingHouse>();
	seedMap = new Map<number, ClearingHouse>();
	nameMap = new Map<string, ClearingHouse>();

	public constructor(
		clearingHouseConfig: ClearingHouseConfig,
		userRegistry: UserRegistry
	) {
		for (const [seed, name] of userRegistry.getUserNames().entries()) {
			clearingHouseConfig.seed = seed;
			const clearingHouse = getClearingHouse(clearingHouseConfig);

			this.clearingHouses.push(clearingHouse);
			this.seedMap.set(seed, clearingHouse);
			this.nameMap.set(name, clearingHouse);
		}
	}
}
