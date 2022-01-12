use crate::controller::position::get_position_index;
use crate::error::ClearingHouseResult;
use crate::error::*;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use crate::math_error;
use crate::state::user_orders::Order;
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::msg;
use std::cmp::min;

use crate::context::*;
use crate::error::*;
use crate::math::quote_asset::{asset_to_reserve_amount, reserve_to_asset_amount};
use crate::math::{amm, bn, constants::*, fees, margin::*, orders::*, position::*, withdrawal::*};
use crate::state::{
    history::order_history::{OrderHistory, OrderRecord},
    history::trade::{TradeHistory, TradeRecord},
    market::{Market, Markets, OracleSource, AMM},
    order_state::*,
    state::*,
    user::{MarketPosition, User, UserPositions},
    user_orders::*,
};
use controller::amm::SwapDirection;
use controller::position::PositionDirection;

use crate::controller;

pub fn fill_order(
    order: &mut Order,
    market: &mut Market,
    user: &mut User,
    market_position: &mut MarketPosition,
    free_collateral: u128,
    oracle_account_info: &AccountInfo,
    max_leverage: u128,
    clock_slot: u64,
    now: i64,
    clearinghouse_state: &State,
    order_state: &OrderState,
) -> ClearingHouseResult<(u128, u128, u128, u128, i128, u128, u128, u128, bool)> {
    // Collect data about position/market before trade is executed so that it can be stored in trade history
    let mark_price_before: u128;
    let oracle_mark_spread_pct_before: i128;
    let is_oracle_valid: bool;
    {
        mark_price_before = market.amm.mark_price()?;
        let (oracle_price, _, _oracle_mark_spread_pct_before) =
            amm::calculate_oracle_mark_spread_pct(
                &market.amm,
                oracle_account_info,
                0,
                clock_slot,
                None,
            )?;
        oracle_mark_spread_pct_before = _oracle_mark_spread_pct_before;
        is_oracle_valid = amm::is_oracle_valid(
            &market.amm,
            oracle_account_info,
            clock_slot,
            &clearinghouse_state.oracle_guard_rails.validity,
        )?;
        if is_oracle_valid {
            amm::update_oracle_price_twap(&mut market.amm, now, oracle_price)?;
        }
    }

    let (base_asset_amount, quote_asset_amount, potentially_risk_increasing) =
        fill_order_to_market(
            order,
            market,
            user,
            market_position,
            free_collateral,
            max_leverage,
            mark_price_before,
            now,
        )?;

    if potentially_risk_increasing && order.reduce_only {
        return Err(ErrorCode::ReduceOnlyOrderIncreasedRisk.into());
    }

    // Collect data about position/market after trade is executed so that it can be stored in trade history
    let mark_price_after: u128;
    let oracle_price_after: i128;
    let oracle_mark_spread_pct_after: i128;
    {
        mark_price_after = market.amm.mark_price()?;
        let (_oracle_price_after, _oracle_mark_spread_after, _oracle_mark_spread_pct_after) =
            amm::calculate_oracle_mark_spread_pct(
                &market.amm,
                oracle_account_info,
                0,
                clock_slot,
                Some(mark_price_after),
            )?;
        oracle_price_after = _oracle_price_after;
        oracle_mark_spread_pct_after = _oracle_mark_spread_pct_after;
    }

    // Don't account for referrer/discount token for now
    let discount_tier = order.discount_tier;
    let (user_fee, fee_to_market, token_discount, filler_reward) =
        fees::calculate_fee_for_limit_order(
            quote_asset_amount,
            &clearinghouse_state.fee_structure,
            &order_state.order_filler_reward_structure,
            &discount_tier,
            order.ts,
            now,
        )?;

    // Increment the clearing house's total fee variables
    {
        market.amm.total_fee = market
            .amm
            .total_fee
            .checked_add(fee_to_market)
            .ok_or_else(math_error!())?;
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(fee_to_market)
            .ok_or_else(math_error!())?;
    }

    // Trade fails if the trade is risk increasing and it pushes to mark price too far
    // away from the oracle price
    let is_oracle_mark_too_divergent = amm::is_oracle_mark_too_divergent(
        oracle_mark_spread_pct_after,
        &clearinghouse_state.oracle_guard_rails.price_divergence,
    )?;
    if is_oracle_mark_too_divergent
        && oracle_mark_spread_pct_after.unsigned_abs()
            >= oracle_mark_spread_pct_before.unsigned_abs()
        && is_oracle_valid
        && potentially_risk_increasing
    {
        return Err(ErrorCode::OracleMarkSpreadLimit.into());
    }

    Ok((
        base_asset_amount,
        quote_asset_amount,
        mark_price_before,
        mark_price_after,
        oracle_price_after,
        user_fee,
        token_discount,
        filler_reward,
        potentially_risk_increasing,
    ))
}

pub fn fill_base_amount_to_market(
    base_asset_amount: u128,
    direction: PositionDirection,
    market: &mut Market,
    user: &mut User,
    market_position: &mut MarketPosition,
    now: i64,
) -> ClearingHouseResult<(bool, u128)> {
    // A trade is risk increasing if it increases the users leverage
    // If a trade is risk increasing and brings the user's margin ratio below initial requirement
    // the trade fails
    // If a trade is risk increasing and it pushes the mark price too far away from the oracle price
    // the trade fails
    let mut potentially_risk_increasing = true;

    // The trade increases the the user position if
    // 1) the user does not have a position
    // 2) the trade is in the same direction as the user's existing position
    let quote_asset_amount;
    let increase_position = market_position.base_asset_amount == 0
        || market_position.base_asset_amount > 0 && direction == PositionDirection::Long
        || market_position.base_asset_amount < 0 && direction == PositionDirection::Short;
    if increase_position {
        quote_asset_amount = controller::position::increase_with_base_asset_amount(
            direction,
            base_asset_amount,
            market,
            market_position,
            now,
        )?;
    } else {
        if market_position.base_asset_amount.unsigned_abs() > base_asset_amount {
            quote_asset_amount = controller::position::reduce_with_base_asset_amount(
                direction,
                base_asset_amount,
                user,
                market,
                market_position,
                now,
            )?;

            potentially_risk_increasing = false;
        } else {
            // after closing existing position, how large should trade be in opposite direction
            let base_asset_amount_after_close = base_asset_amount
                .checked_sub(market_position.base_asset_amount.unsigned_abs())
                .ok_or_else(math_error!())?;

            // If the value of the new position is less than value of the old position, consider it risk decreasing
            if base_asset_amount_after_close < market_position.base_asset_amount.unsigned_abs() {
                potentially_risk_increasing = false;
            }

            let (quote_asset_amount_closed, _) =
                controller::position::close(user, market, market_position, now)?;

            let quote_asset_amount_opened = controller::position::increase_with_base_asset_amount(
                direction,
                base_asset_amount_after_close,
                market,
                market_position,
                now,
            )?;

            quote_asset_amount = quote_asset_amount_closed
                .checked_add(quote_asset_amount_opened)
                .ok_or_else(math_error!())?;
        }
    }

    Ok((potentially_risk_increasing, quote_asset_amount))
}

pub fn fill_order_to_market(
    order: &mut Order,
    market: &mut Market,
    user: &mut User,
    market_position: &mut MarketPosition,
    free_collateral: u128,
    max_leverage: u128,
    mark_price_before: u128,
    now: i64,
) -> ClearingHouseResult<(u128, u128, bool)> {
    let minimum_base_asset_trade_size = market.amm.minimum_base_asset_trade_size;

    let base_asset_amount: u128;
    {
        let order_swap_direction = match order.direction {
            PositionDirection::Long => SwapDirection::Add,
            PositionDirection::Short => SwapDirection::Remove,
        };

        let quote_asset_reserve_amount = asset_to_reserve_amount(
            free_collateral
                .checked_mul(max_leverage)
                .ok_or_else(math_error!())?,
            market.amm.peg_multiplier,
        )?;

        let initial_base_asset_amount = market.amm.base_asset_reserve;
        let (new_base_asset_amount, new_quote_asset_amount) = amm::calculate_swap_output(
            quote_asset_reserve_amount,
            market.amm.quote_asset_reserve,
            order_swap_direction,
            market.amm.sqrt_k,
        )?;

        let max_user_base_asset_amount = cast_to_i128(initial_base_asset_amount)?
            .checked_sub(cast(new_base_asset_amount)?)
            .ok_or_else(math_error!())?
            .unsigned_abs();

        let trade_base_asset_amount =
            calculate_base_asset_amount_to_trade(order, market, Some(mark_price_before))?;

        let proposed_base_asset_amount = min(max_user_base_asset_amount, trade_base_asset_amount);

        let base_asset_amount_left_to_fill = order
            .base_asset_amount
            .checked_sub(
                order
                    .base_asset_amount_filled
                    .checked_add(proposed_base_asset_amount)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?;

        if base_asset_amount_left_to_fill > 0
            && base_asset_amount_left_to_fill < minimum_base_asset_trade_size
        {
            base_asset_amount = proposed_base_asset_amount
                .checked_add(base_asset_amount_left_to_fill)
                .ok_or_else(math_error!())?;
        } else {
            base_asset_amount = proposed_base_asset_amount;
        }
    }

    let (potentially_risk_increasing, quote_asset_amount) = fill_base_amount_to_market(
        base_asset_amount,
        order.direction,
        market,
        user,
        market_position,
        now,
    )?;

    update_order_after_trade(
        order,
        minimum_base_asset_trade_size,
        base_asset_amount,
        quote_asset_amount,
    )?;

    Ok((
        base_asset_amount,
        quote_asset_amount,
        potentially_risk_increasing,
    ))
}

pub fn update_order_after_trade(
    order: &mut Order,
    minimum_base_asset_trade_size: u128,
    base_asset_amount: u128,
    quote_asset_amount: u128,
) -> ClearingHouseResult {
    order.base_asset_amount_filled = order
        .base_asset_amount_filled
        .checked_add(base_asset_amount)
        .ok_or_else(math_error!())?;

    order.quote_asset_amount_filled = order
        .quote_asset_amount_filled
        .checked_add(quote_asset_amount)
        .ok_or_else(math_error!())?;

    // redudancy test to make sure no min trade size remaining
    let base_asset_amount_to_fill = order
        .base_asset_amount
        .checked_sub(order.base_asset_amount_filled)
        .ok_or_else(math_error!())?;

    if base_asset_amount_to_fill > 0 && base_asset_amount_to_fill < minimum_base_asset_trade_size {
        return Err(ErrorCode::OrderAmountTooSmall.into());
    }

    Ok(())
}
