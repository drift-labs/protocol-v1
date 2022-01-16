import {
	OrderParams,
	OrderTriggerCondition,
	OrderType,
	PositionDirection,
} from './types';
import { BN } from '@project-serum/anchor';
import { ZERO } from './constants/numericConstants';

export function getLimitOrderParams(
	marketIndex: BN,
	direction: PositionDirection,
	baseAssetAmount: BN,
	price: BN,
	reduceOnly: boolean,
	discountToken = false,
	referrer = false
): OrderParams {
	return {
		orderType: OrderType.LIMIT,
		marketIndex,
		direction,
		quoteAssetAmount: ZERO,
		baseAssetAmount,
		price,
		reduceOnly,
		postOnly: false,
		immediateOrCancel: false,
		optionalAccounts: {
			discountToken,
			referrer,
		},
		triggerCondition: OrderTriggerCondition.ABOVE,
		triggerPrice: ZERO,
	};
}

export function getStopOrderParams(
	marketIndex: BN,
	direction: PositionDirection,
	baseAssetAmount: BN,
	triggerPrice: BN,
	triggerCondition: OrderTriggerCondition,
	reduceOnly: boolean,
	discountToken = false,
	referrer = false
): OrderParams {
	return {
		orderType: OrderType.STOP,
		marketIndex,
		direction,
		quoteAssetAmount: ZERO,
		baseAssetAmount,
		price: ZERO,
		reduceOnly,
		postOnly: false,
		immediateOrCancel: false,
		optionalAccounts: {
			discountToken,
			referrer,
		},
		triggerCondition,
		triggerPrice,
	};
}

export function getMarketOrderParams(
	marketIndex: BN,
	direction: PositionDirection,
	quoteAssetAmount: BN,
	baseAssetAmount: BN,
	reduceOnly: boolean,
	price = ZERO,
	discountToken = false,
	referrer = false
): OrderParams {
	if (baseAssetAmount.eq(ZERO) && quoteAssetAmount.eq(ZERO)) {
		throw Error('baseAssetAmount or quoteAssetAmount must be zero');
	}

	return {
		orderType: OrderType.MARKET,
		marketIndex,
		direction,
		quoteAssetAmount,
		baseAssetAmount,
		price,
		reduceOnly,
		postOnly: false,
		immediateOrCancel: false,
		optionalAccounts: {
			discountToken,
			referrer,
		},
		triggerCondition: OrderTriggerCondition.ABOVE,
		triggerPrice: ZERO,
	};
}
