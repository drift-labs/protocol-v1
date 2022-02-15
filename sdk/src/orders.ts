import {
	isVariant,
	Market,
	Order,
	PositionDirection,
	UserAccount,
	UserPosition,
} from './types';
import { BN } from '.';
import {
	calculateMarkPrice,
	calculateNewMarketAfterTrade,
} from './math/market';
import {
	AMM_TO_QUOTE_PRECISION_RATIO,
	PEG_PRECISION,
	ZERO,
} from './constants/numericConstants';
import { calculateMaxBaseAssetAmountToTrade } from './math/amm';
import {
	findDirectionToClose,
	positionCurrentDirection,
} from './math/position';

export function calculateNewStateAfterOrder(
	userAccount: UserAccount,
	userPosition: UserPosition,
	market: Market,
	order: Order
): [UserAccount, UserPosition, Market] | null {
	if (isVariant(order.status, 'init')) {
		return null;
	}

	const baseAssetAmountToTrade = calculateAmountToTrade(market, order);
	if (baseAssetAmountToTrade.lt(market.amm.minimumBaseAssetTradeSize)) {
		return null;
	}

	const userAccountAfter = Object.assign({}, userAccount);
	const userPositionAfter = Object.assign({}, userPosition);

	const currentPositionDirection = positionCurrentDirection(userPosition);
	const increasePosition =
		userPosition.baseAssetAmount.eq(ZERO) ||
		isSameDirection(order.direction, currentPositionDirection);

	if (increasePosition) {
		const marketAfter = calculateNewMarketAfterTrade(
			baseAssetAmountToTrade,
			order.direction,
			market
		);

		const { quoteAssetAmountSwapped, baseAssetAmountSwapped } =
			calculateAmountSwapped(market, marketAfter);

		userPositionAfter.baseAssetAmount = userPositionAfter.baseAssetAmount.add(
			baseAssetAmountSwapped
		);
		userPositionAfter.quoteAssetAmount = userPositionAfter.quoteAssetAmount.add(
			quoteAssetAmountSwapped
		);

		return [userAccountAfter, userPositionAfter, marketAfter];
	} else {
		const reversePosition = baseAssetAmountToTrade.gt(
			userPosition.baseAssetAmount.abs()
		);

		if (reversePosition) {
			const intermediateMarket = calculateNewMarketAfterTrade(
				userPosition.baseAssetAmount,
				findDirectionToClose(userPosition),
				market
			);

			const { quoteAssetAmountSwapped: baseAssetValue } =
				calculateAmountSwapped(market, intermediateMarket);

			let pnl;
			if (isVariant(currentPositionDirection, 'long')) {
				pnl = baseAssetValue.sub(userPosition.quoteAssetAmount);
			} else {
				pnl = userPosition.quoteAssetAmount.sub(baseAssetValue);
			}

			userAccountAfter.collateral = userAccountAfter.collateral.add(pnl);

			const baseAssetAmountLeft = baseAssetAmountToTrade.sub(
				userPosition.baseAssetAmount.abs()
			);

			const marketAfter = calculateNewMarketAfterTrade(
				baseAssetAmountLeft,
				order.direction,
				intermediateMarket
			);

			const { quoteAssetAmountSwapped, baseAssetAmountSwapped } =
				calculateAmountSwapped(intermediateMarket, marketAfter);

			userPositionAfter.quoteAssetAmount = quoteAssetAmountSwapped;
			userPositionAfter.baseAssetAmount = baseAssetAmountSwapped;

			return [userAccountAfter, userPositionAfter, marketAfter];
		} else {
			const marketAfter = calculateNewMarketAfterTrade(
				baseAssetAmountToTrade,
				order.direction,
				market
			);

			const {
				quoteAssetAmountSwapped: baseAssetValue,
				baseAssetAmountSwapped,
			} = calculateAmountSwapped(market, marketAfter);

			const costBasisRealized = userPosition.quoteAssetAmount
				.mul(baseAssetAmountSwapped.abs())
				.div(userPosition.baseAssetAmount.abs());

			let pnl;
			if (isVariant(currentPositionDirection, 'long')) {
				pnl = baseAssetValue.sub(costBasisRealized);
			} else {
				pnl = costBasisRealized.sub(baseAssetValue);
			}

			userAccountAfter.collateral = userAccountAfter.collateral.add(pnl);

			userPositionAfter.baseAssetAmount = userPositionAfter.baseAssetAmount.add(
				baseAssetAmountSwapped
			);
			userPositionAfter.quoteAssetAmount =
				userPositionAfter.quoteAssetAmount.sub(costBasisRealized);

			return [userAccountAfter, userPositionAfter, marketAfter];
		}
	}
}

function calculateAmountSwapped(
	marketBefore: Market,
	marketAfter: Market
): { quoteAssetAmountSwapped: BN; baseAssetAmountSwapped: BN } {
	return {
		quoteAssetAmountSwapped: marketBefore.amm.quoteAssetReserve
			.sub(marketAfter.amm.quoteAssetReserve)
			.abs()
			.mul(marketBefore.amm.pegMultiplier)
			.div(PEG_PRECISION)
			.div(AMM_TO_QUOTE_PRECISION_RATIO),
		baseAssetAmountSwapped: marketBefore.amm.baseAssetReserve.sub(
			marketAfter.amm.baseAssetReserve
		),
	};
}

function calculateAmountToTrade(market: Market, order: Order): BN {
	if (isVariant(order.orderType, 'limit')) {
		return calculateAmountToTradeForLimit(market, order);
	} else if (isVariant(order.orderType, 'triggerLimit')) {
		return calculateAmountToTradeForTriggerLimit(market, order);
	} else if (isVariant(order.orderType, 'market')) {
		// should never be a market order queued
		return ZERO;
	} else {
		return calculateAmountToTradeForTriggerMarket(market, order);
	}
}

export function calculateAmountToTradeForLimit(
	market: Market,
	order: Order
): BN {
	const [maxAmountToTrade, direction] = calculateMaxBaseAssetAmountToTrade(
		market.amm,
		order.price
	);

	// Check that directions are the same
	const sameDirection = isSameDirection(direction, order.direction);
	if (!sameDirection) {
		return ZERO;
	}

	return maxAmountToTrade.gt(order.baseAssetAmount)
		? order.baseAssetAmount
		: maxAmountToTrade;
}

export function calculateAmountToTradeForTriggerLimit(
	market: Market,
	order: Order
): BN {
	if (order.baseAssetAmountFilled.eq(ZERO)) {
		const baseAssetAmount = calculateAmountToTradeForTriggerMarket(
			market,
			order
		);
		if (baseAssetAmount.eq(ZERO)) {
			return ZERO;
		}
	}

	return calculateAmountToTradeForLimit(market, order);
}

function isSameDirection(
	firstDirection: PositionDirection,
	secondDirection: PositionDirection
): boolean {
	return (
		(isVariant(firstDirection, 'long') && isVariant(secondDirection, 'long')) ||
		(isVariant(firstDirection, 'short') && isVariant(secondDirection, 'short'))
	);
}

function calculateAmountToTradeForTriggerMarket(
	market: Market,
	order: Order
): BN {
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
