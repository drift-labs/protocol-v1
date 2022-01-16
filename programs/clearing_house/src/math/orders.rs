use crate::error::*;
use crate::math;
use crate::math_error;
use crate::state::market::Market;
use crate::state::user_orders::{Order, OrderTriggerCondition, OrderType};
use solana_program::msg;
use std::cell::{Ref, RefMut};
use std::cmp::min;
use std::ops::Div;

use crate::controller::position::PositionDirection;
use crate::controller::position::{add_new_position, get_position_index};
use crate::error::*;
use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO, MARGIN_PRECISION, MARK_PRICE_PRECISION,
};
use crate::math::margin::calculate_free_collateral;
use crate::state::market::Markets;
use crate::state::user::{MarketPosition, User, UserPositions};

pub fn calculate_base_asset_amount_to_trade(
    order: &Order,
    market: &Market,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<u128> {
    match order.order_type {
        OrderType::Limit => calculate_base_asset_amount_to_trade_for_limit(order, market),
        OrderType::Stop => {
            calculate_base_asset_amount_to_trade_for_stop(order, market, precomputed_mark_price)
        }
        OrderType::Market => Err(ErrorCode::InvalidOrder.into()),
    }
}

fn calculate_base_asset_amount_to_trade_for_limit(
    order: &Order,
    market: &Market,
) -> ClearingHouseResult<u128> {
    let base_asset_amount_to_fill = order
        .base_asset_amount
        .checked_sub(order.base_asset_amount_filled)
        .ok_or_else(math_error!())?;

    let (max_trade_base_asset_amount, max_trade_direction) =
        math::amm::calculate_max_base_asset_amount_to_trade(&market.amm, order.price)?;
    if max_trade_direction != order.direction || max_trade_base_asset_amount == 0 {
        return Ok(0);
    }

    let base_asset_amount_to_trade = min(base_asset_amount_to_fill, max_trade_base_asset_amount);

    Ok(base_asset_amount_to_trade)
}

fn calculate_base_asset_amount_to_trade_for_stop(
    order: &Order,
    market: &Market,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<u128> {
    let mark_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => market.amm.mark_price()?,
    };

    match order.trigger_condition {
        OrderTriggerCondition::Above => {
            if mark_price <= order.trigger_price {
                return Ok(0);
            }
        }
        OrderTriggerCondition::Below => {
            if mark_price >= order.trigger_price {
                return Ok(0);
            }
        }
    }

    Ok(order.base_asset_amount)
}

pub fn calculate_available_quote_asset_for_order(
    user: &User,
    order: &Order,
    position_index: usize,
    user_positions: &mut UserPositions,
    markets: &Markets,
    margin_ratio_initial: u128,
) -> ClearingHouseResult<u128> {
    let market_position = &user_positions.positions[position_index];

    let max_leverage = MARGIN_PRECISION
        .checked_div(margin_ratio_initial)
        .ok_or_else(math_error!())?;

    let risk_increasing = market_position.base_asset_amount == 0
        || market_position.base_asset_amount > 0 && order.direction == PositionDirection::Long
        || market_position.base_asset_amount < 0 && order.direction == PositionDirection::Short;

    let (total_collateral, base_asset_value, free_collateral) =
        calculate_free_collateral(user, user_positions, markets, max_leverage)?;

    let available_quote_asset_for_order: u128;
    if risk_increasing {
        available_quote_asset_for_order = free_collateral
            .checked_mul(max_leverage)
            .ok_or_else(math_error!())?;
    } else {
        let max_flipped_size = total_collateral
            .checked_mul(max_leverage)
            .ok_or_else(math_error!())?;

        available_quote_asset_for_order = max_flipped_size
            .checked_add(base_asset_value)
            .ok_or_else(math_error!())?;
    }

    Ok(available_quote_asset_for_order)
}

pub fn limit_price_satisfied(
    limit_price: u128,
    quote_asset_amount: u128,
    base_asset_amount: u128,
    direction: PositionDirection,
) -> ClearingHouseResult<bool> {
    let price = quote_asset_amount
        .checked_mul(MARK_PRICE_PRECISION * AMM_TO_QUOTE_PRECISION_RATIO)
        .ok_or_else(math_error!())?
        .div(base_asset_amount);

    match direction {
        PositionDirection::Long => {
            if price > limit_price {
                return Ok(false);
            }
        }
        PositionDirection::Short => {
            if price < limit_price {
                return Ok(false);
            }
        }
    }

    return Ok(true);
}
