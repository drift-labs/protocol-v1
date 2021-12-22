use crate::state::user_orders::{Order, OrderType, OrderTriggerCondition};
use crate::state::market::Market;
use crate::error::*;
use crate::math;
use std::cmp::min;
use crate::math_error;
use solana_program::msg;

pub fn calculate_base_asset_amount_to_trade(order: &Order, market: &Market, precomputed_mark_price: Option<u128>) -> ClearingHouseResult<u128> {
    match order.order_type {
        OrderType::Limit => calculate_base_asset_amount_to_trade_for_limit(order, market),
        OrderType::Stop => calculate_base_asset_amount_to_trade_for_stop(order, market, precomputed_mark_price),
    }
}

fn calculate_base_asset_amount_to_trade_for_limit(order: &Order, market: &Market) -> ClearingHouseResult<u128> {
    let base_asset_amount_to_fill = order.base_asset_amount
        .checked_sub(order.base_asset_amount_filled)
        .ok_or_else(math_error!())?;

    let (max_trade_base_asset_amount, max_trade_direction) = math::amm::calculate_max_base_asset_amount_to_trade(&market.amm, order.price)?;
    if max_trade_direction != order.direction || max_trade_base_asset_amount == 0 {
        return Err(ErrorCode::MarketCantFillOrder.into());
    }

    let base_asset_amount_to_trade = min(base_asset_amount_to_fill, max_trade_base_asset_amount);

    Ok(base_asset_amount_to_trade)
}

fn calculate_base_asset_amount_to_trade_for_stop(order: &Order, market: &Market, precomputed_mark_price: Option<u128>) -> ClearingHouseResult<u128> {
    let mark_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => market.amm.mark_price()?,
    };

    match order.trigger_condition {
        OrderTriggerCondition::Above => {
            if mark_price <= order.trigger_price {
                return Err(ErrorCode::OrderTriggerConditionNotSatisfied.into());
            }
        },
        OrderTriggerCondition::Below => {
            if mark_price >= order.trigger_price {
                return Err(ErrorCode::OrderTriggerConditionNotSatisfied.into());
            }
        }
    }

    Ok(order.base_asset_amount)
}