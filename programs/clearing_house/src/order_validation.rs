use crate::error::*;
use crate::math::constants::*;
use crate::math::quote_asset::asset_to_reserve_amount;
use crate::math_error;
use crate::state::market::Market;
use crate::state::order_state::OrderState;
use crate::state::user_orders::{Order, OrderType};

use solana_program::msg;

pub fn validate_order(
    order: &Order,
    market: &Market,
    order_state: &OrderState,
) -> ClearingHouseResult {
    match order.order_type {
        OrderType::Market => validate_market_order(order, market)?,
        OrderType::Limit => validate_limit_order(order, market, order_state)?,
        OrderType::Stop => validate_stop_order(order, market, order_state)?,
    }

    Ok(())
}

fn validate_market_order(order: &Order, market: &Market) -> ClearingHouseResult {
    if order.quote_asset_amount > 0 && order.base_asset_amount > 0 {
        msg!("Market order should not have quote_asset_amount and base_asset_amount set");
        return Err(ErrorCode::InvalidOrder.into());
    }

    if order.base_asset_amount > 0 {
        validate_base_asset_amount(order, market)?;
    } else {
        validate_quote_asset_amount(order, market)?;
    }

    if order.trigger_price > 0 {
        msg!("Market should not have trigger price");
        return Err(ErrorCode::InvalidOrder.into());
    }

    Ok(())
}

fn validate_limit_order(
    order: &Order,
    market: &Market,
    order_state: &OrderState,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, market)?;

    if order.price == 0 {
        msg!("Limit order price == 0");
        return Err(ErrorCode::InvalidOrder.into());
    }

    if order.trigger_price > 0 {
        msg!("Limit order should not have trigger price");
        return Err(ErrorCode::InvalidOrder.into());
    }

    let approx_market_value = order
        .price
        .checked_mul(order.base_asset_amount)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(MARK_PRICE_PRECISION / QUOTE_PRECISION)
        .ok_or_else(math_error!())?;

    if approx_market_value < order_state.min_order_quote_asset_amount {
        msg!("Order {:?} @ {:?}", order.base_asset_amount, order.price);
        msg!("Order value < $0.50 ({:?})", approx_market_value);
        return Err(ErrorCode::InvalidOrder.into());
    }

    Ok(())
}

fn validate_stop_order(
    order: &Order,
    market: &Market,
    order_state: &OrderState,
) -> ClearingHouseResult {
    validate_base_asset_amount(order, market)?;

    if order.price > 0 {
        msg!("Stop order should not have price");
        return Err(ErrorCode::InvalidOrder.into());
    }
    if order.trigger_price == 0 {
        msg!("Stop order trigger_price == 0");
        return Err(ErrorCode::InvalidOrder.into());
    }
    let approx_market_value = order
        .trigger_price
        .checked_mul(order.base_asset_amount)
        .ok_or_else(math_error!())?
        .checked_div(AMM_RESERVE_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(MARK_PRICE_PRECISION / QUOTE_PRECISION)
        .ok_or_else(math_error!())?;

    // decide min trade size ($10?)
    if approx_market_value < order_state.min_order_quote_asset_amount {
        msg!("Order value < $0.50 ({:?})", approx_market_value);
        return Err(ErrorCode::InvalidOrder.into());
    }

    Ok(())
}

fn validate_base_asset_amount(order: &Order, market: &Market) -> ClearingHouseResult {
    if order.base_asset_amount == 0 {
        msg!("Order base_asset_amount cant be 0");
        return Err(ErrorCode::InvalidOrder.into());
    }

    if order.base_asset_amount < market.amm.minimum_base_asset_trade_size {
        msg!("Order base_asset_amount smaller than market minimum_base_asset_trade_size");
        return Err(ErrorCode::InvalidOrder.into());
    }

    Ok(())
}

fn validate_quote_asset_amount(order: &Order, market: &Market) -> ClearingHouseResult {
    if order.quote_asset_amount == 0 {
        msg!("Order quote_asset_amount cant be 0");
        return Err(ErrorCode::InvalidOrder.into());
    }

    let quote_asset_reserve_amount =
        asset_to_reserve_amount(order.quote_asset_amount, market.amm.peg_multiplier)?;

    if quote_asset_reserve_amount < market.amm.minimum_quote_asset_trade_size {
        msg!("Order quote_asset_reserve_amount smaller than market minimum_quote_asset_trade_size");
        return Err(ErrorCode::InvalidOrder.into());
    }

    Ok(())
}
