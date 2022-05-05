import { squareRootBN, OrderFillerRewardStructure } from '..';
import { BN } from '@project-serum/anchor';

export function calculateFillerReward(
	userFee: BN,
	orderTs: BN,
	now: BN,
	fillerRewardStructure: OrderFillerRewardStructure
): BN {
	// incentivize keepers to prioritize filling older orders (rather than just largest orders)
	// for sufficiently small-sized order, reward based on fraction of fee paid
	const sizeFillerReward = userFee
		.mul(fillerRewardStructure.rewardNumerator)
		.div(fillerRewardStructure.rewardDenominator);
	const timeSinceOrder = BN.max(new BN(1), now.sub(orderTs));
	const timeFillerReward = squareRootBN(
		squareRootBN(timeSinceOrder.mul(new BN(10 ** 8)))
	)
		.mul(fillerRewardStructure.timeBasedRewardLowerBound)
		.div(new BN(100));

	return BN.min(sizeFillerReward, timeFillerReward);
}
