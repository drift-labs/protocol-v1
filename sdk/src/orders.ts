import { ClearingHouseUser } from './clearingHouseUser';
import { isVariant, Market, Order } from './types';
import BN from 'bn.js';
import { calculateMarkPrice } from './math/market';
import { ZERO } from './constants/numericConstants';
import { calculateMaxBaseAssetAmountToTrade } from './math/amm';

/**
 * Determines if the amm can support trade being filled.
 * Does not consider user margin ratio yet
 *
 * @param user
 * @param order
 */
export function canFillUserOrder(
	user: ClearingHouseUser,
	order: Order
): boolean {
	if (isVariant(order.status, 'init')) {
		return false;
	}

	const market = user.clearingHouse.getMarket(order.marketIndex);
	const baseAssetAmountToTrade = calculateAmountToTrade(market, order);
	return baseAssetAmountToTrade.gt(ZERO);
}

function calculateAmountToTrade(market: Market, order: Order): BN {
	if (isVariant(order.orderType, 'limit')) {
		console.log('limit');
		return calculateAmountToTradeForLimit(market, order);
	} else {
		return calculateAmountToTradeForStop(market, order);
	}
}

function calculateAmountToTradeForLimit(market: Market, order: Order): BN {
	const [maxAmountToTrade, direction] = calculateMaxBaseAssetAmountToTrade(
		market.amm,
		order.price
	);

	// Check that directions are the same
	const sameDirection =
		isVariant(direction, 'long') && isVariant(order.direction, 'long');
	if (!sameDirection) {
		return ZERO;
	}

	return maxAmountToTrade.gt(order.baseAssetAmount)
		? order.baseAssetAmount
		: maxAmountToTrade;
}

function calculateAmountToTradeForStop(market: Market, order: Order): BN {
	return isTriggerConditionSatisfied(market, order)
		? order.baseAssetAmount
		: ZERO;
}

function isTriggerConditionSatisfied(market: Market, order: Order): boolean {
	const markPrice = calculateMarkPrice(market);
	if (isVariant(order.triggerCondition, 'above')) {
		return markPrice.gt(order.triggerPrice);
	} else {
		return markPrice.lt(order.triggerPrice);
	}
}
