import {ClearingHouseUser} from "./clearingHouseUser";
import {Market, Order, OrderTriggerCondition, OrderType} from "./types";
import BN from "bn.js";
import {calculateMarkPrice} from "./math/market";
import {ZERO} from "./constants/numericConstants";
import {calculateMaxBaseAssetAmountToTrade} from "./math/amm";

/**
 * Determines if the amm can support trade being filled.
 * Does not consider user margin ratio yet
 *
 * @param user
 * @param order
 */
export function canFillUserOrder(user: ClearingHouseUser, order: Order) : boolean {
    const market = user.clearingHouse.getMarket(order.marketIndex);
    const baseAssetAmountToTrade = calculateAmountToTrade(market, order);
    return baseAssetAmountToTrade.gt(ZERO);
}

function calculateAmountToTrade(market: Market, order: Order) : BN {
    switch (order.orderType) {
        case OrderType.LIMIT:
            return calculateAmountToTradeForLimit(market, order);
        case OrderType.STOP:
            return calculateAmountToTradeForStop(market, order);
        default:
            throw new Error("Unknown order type");
    }
}

function calculateAmountToTradeForLimit(market: Market, order: Order) : BN {
    const [maxAmountToTrade, direction] = calculateMaxBaseAssetAmountToTrade(market.amm, order.price);

    if (direction != order.direction) {
        return ZERO;
    }

    return maxAmountToTrade.gt(order.baseAssetAmount) ? order.baseAssetAmount : maxAmountToTrade;
}

function calculateAmountToTradeForStop(market: Market, order: Order) : BN {
    return isTriggerConditionSatisfied(market, order) ? order.baseAssetAmount : ZERO;
}

function isTriggerConditionSatisfied(market: Market, order: Order) : boolean {
    const markPrice = calculateMarkPrice(market);
    switch (order.triggerCondition) {
        case OrderTriggerCondition.ABOVE:
            return markPrice.gt(order.triggerPrice);
        case OrderTriggerCondition.BELOW:
            return markPrice.lt(order.triggerPrice);
    }
}