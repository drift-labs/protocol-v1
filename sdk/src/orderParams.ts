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
	discountToken: boolean
): OrderParams {
	return {
		orderType: OrderType.LIMIT,
		marketIndex,
		direction,
		baseAssetAmount,
		price,
		reduceOnly,
		postOnly: false,
		immediateOrCancel: false,
		optionalAccounts: {
			discountToken,
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
	discountToken: boolean
): OrderParams {
	return {
		orderType: OrderType.STOP,
		marketIndex,
		direction,
		baseAssetAmount,
		price: ZERO,
		reduceOnly,
		postOnly: false,
		immediateOrCancel: false,
		optionalAccounts: {
			discountToken,
		},
		triggerCondition,
		triggerPrice,
	};
}
