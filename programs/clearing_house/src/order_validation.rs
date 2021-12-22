use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::market::Market;
use crate::state::user_orders::{Order, OrderType};
use solana_program::msg;

pub fn validate_order(order: &Order, market: &Market) -> ClearingHouseResult {
    if order.base_asset_amount == 0 {
        msg!("Order base_asset_amount cant be 0");
        return Err(ErrorCode::InvalidOrder.into());
    }

    if order.base_asset_amount < market.amm.minimum_base_asset_trade_size {
        msg!("Order base_asset_amount smaller than market minimum_base_asset_trade_size");
        return Err(ErrorCode::InvalidOrder.into());
    }

    match order.order_type {
        OrderType::Limit => validate_limit_order(order)?,
        OrderType::Stop => validate_stop_order(order)?,
    }

    Ok(())
}

fn validate_limit_order(order: &Order) -> ClearingHouseResult {
    if order.trigger_price > 0 {
        msg!("Limit order should not have trigger price");
        return Err(ErrorCode::InvalidOrder.into());
    }
    Ok(())
}

fn validate_stop_order(order: &Order) -> ClearingHouseResult {
    if order.price > 0 {
        msg!("Stop order should not have price");
        return Err(ErrorCode::InvalidOrder.into());
    }
    Ok(())
}
