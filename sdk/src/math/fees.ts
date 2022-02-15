import { BN, ClearingHouseUser, FeeStructure, ZERO } from "@drift-labs/sdk";
import { AccountInfo } from "@solana/spl-token";
import { Order, OrderFillerRewardStructure } from "..";
import { OrderDiscountTier } from "../types";


export function calculateFeeForMarketOrder(quoteAssetAmount: BN, feeStructure: FeeStructure, discountToken?: AccountInfo, referrer?: ClearingHouseUser ) : Array<BN> {
    const fee = quoteAssetAmount.mul(feeStructure.feeNumerator).div(feeStructure.feeDenominator)
    const tokenDiscount = calculateTokenDiscount(fee, feeStructure, discountToken)
    const [referrerReward, refereeDiscount] = calculateReferralRewardAndRefereeDiscount(fee, feeStructure, referrer)
    const userFee = fee.sub(tokenDiscount).sub(refereeDiscount);
    const feeToMarket = userFee.sub(referrerReward);
    return [userFee,feeToMarket,tokenDiscount,referrerReward,refereeDiscount]
}

export function calculateTokenDiscount(fee: BN, feeStructure: FeeStructure, discountToken?: AccountInfo) : BN {
    let discount = ZERO;

    if (!discountToken) {
        return discount;
    }

    Object.keys(feeStructure.discountTokenTiers).forEach(tier => {
        let possibleDiscount = tryToCalculateTokenDiscountForTier(fee, feeStructure.discountTokenTiers[tier], discountToken)
        if (possibleDiscount > discount) {
            discount = possibleDiscount;
        }
    })

}

export function tryToCalculateTokenDiscountForTier(fee : BN, tier : { minimumBalance: BN, discountNumerator: BN, discountDenominator: BN }, discountToken : AccountInfo) : BN {
    if (belongsToTier(tier, discountToken)) {
        return calculateTokenDiscountForTier(fee, tier);
    }
    return ZERO;
}

export function calculateTokenDiscountForTier(fee : BN, tier : { minimumBalance: BN, discountNumerator: BN, discountDenominator: BN }) : BN {
    return fee.mul(tier.discountNumerator).div(tier.discountDenominator)
}

export function belongsToTier(tier: { minimumBalance: BN, discountNumerator: BN, discountDenominator: BN }, discountToken: AccountInfo) : boolean {
    return discountToken.amount >= tier.minimumBalance;
}

export function calculateReferralRewardAndRefereeDiscount(fee: BN, feeStructure: FeeStructure, referrer?: ClearingHouseUser) : Array<BN> {
    let [referralReward, refereeDiscount] = [ZERO, ZERO];
    if (referrer) {
        referralReward = fee.mul(feeStructure.referralDiscount.referrerRewardNumerator).div(feeStructure.referralDiscount.referrerRewardDenominator);
        refereeDiscount = fee.mul(feeStructure.referralDiscount.refereeDiscountNumerator).div(feeStructure.referralDiscount.refereeDiscountDenominator);
    }
    return [referralReward, refereeDiscount];
}

export function calculateOrderFeeTier(feeStructure: FeeStructure, discountToken?: AccountInfo) {

    let tier = OrderDiscountTier.NONE;
    let tierIndex = -1;
    if (discountToken) {
        Object.keys(feeStructure.discountTokenTiers).forEach((discountTier, index) => {
            if (belongsToTier(feeStructure.discountTokenTiers[discountTier], discountToken) && index > tierIndex) {
                tierIndex = index;
                tier = OrderDiscountTier[discountTier.split('Tier')[0].toUpperCase()];
            }
        })
    }
    return tier;

}

export function calculateFeeForLimitOrder(quoteAssetAmount : BN, feeStructure: FeeStructure, fillerRewardStructure: OrderFillerRewardStructure, orderFeeTier: OrderDiscountTier, orderTs: BN, now: BN, referrer?: ClearingHouseUser, fillerIsTaker: boolean = false) : Array<BN> {
    const fee = quoteAssetAmount.mul(feeStructure.feeNumerator).div(feeStructure.feeDenominator);
    const tokenDiscount = calculateTokenDiscountForLimitOrder(fee, feeStructure, orderFeeTier);
    const [referrerReward, refereeDiscount] = calculateReferralRewardAndRefereeDiscount(fee, feeStructure, referrer);
    const userFee = fee.sub(refereeDiscount).sub(tokenDiscount);
    const fillerReward = fillerIsTaker ? ZERO : calculateFillerReward(userFee, orderTs, now, fillerRewardStructure);
    const feeToMarket = userFee.sub(fillerReward).sub(referrerReward);
    return [userFee, feeToMarket, tokenDiscount, fillerReward, referrerReward, refereeDiscount]
}

export function calculateTokenDiscountForLimitOrder(fee: BN, feeStructure: FeeStructure, orderFeeTier: OrderDiscountTier) : BN {
    let tokenDiscount = ZERO;
    switch(orderFeeTier) {
        case OrderDiscountTier.FIRST:
            tokenDiscount = calculateTokenDiscountForTier(fee, feeStructure.discountTokenTiers.firstTier)
            break;
        case OrderDiscountTier.SECOND:
            tokenDiscount = calculateTokenDiscountForTier(fee, feeStructure.discountTokenTiers.secondTier)
            break;
        case OrderDiscountTier.THIRD:
            tokenDiscount = calculateTokenDiscountForTier(fee, feeStructure.discountTokenTiers.thirdTier)
            break;
        case OrderDiscountTier.FOURTH:
            tokenDiscount = calculateTokenDiscountForTier(fee, feeStructure.discountTokenTiers.fourthTier)
            break;
    }
    return tokenDiscount;
}

// https://github.com/indutny/bn.js/pull/277
// https://en.wikipedia.org/wiki/Methods_of_computing_square_roots#Babylonian_method
function sqrt (input: BN) {
    var z = new BN(0);
    if (input.gt(new BN(3))) {
      z = input;
      var x = input.div(new BN(2)).add(new BN(1));
      while (x.lt(z)) {
        z = x;
        x = input.div(x).add(x).div(new BN(2));
      }
    } else if (!input.eq(new BN(0))) {
      z = new BN(1);
    }
    return z;
};

export function calculateFillerReward(userFee: BN, orderTs: BN, now: BN, fillerRewardStructure: OrderFillerRewardStructure) : BN {
    // incentivize keepers to prioritize filling older orders (rather than just largest orders)
    // for sufficiently small-sized order, reward based on fraction of fee paid
    const sizeFillerReward = userFee.mul(fillerRewardStructure.rewardNumerator).div(fillerRewardStructure.rewardDenominator);
    const timeSinceOrder = BN.max(new BN(1), now.sub(orderTs));
	const timeFillerReward = (sqrt(sqrt(timeSinceOrder.mul(new BN(10 ** 8)))).mul(fillerRewardStructure.timeBasedRewardLowerbound)).div(new BN(100))

	return BN.min(sizeFillerReward, timeFillerReward);
}