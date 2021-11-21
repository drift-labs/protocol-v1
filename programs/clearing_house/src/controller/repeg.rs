use crate::controller;
use crate::error::*;
use crate::math;
use crate::math::{amm, bn, quote_asset::*};

use crate::controller::amm::SwapDirection;

use crate::math::constants::{
    PRICE_TO_PEG_PRECISION_RATIO, PRICE_TO_PEG_QUOTE_PRECISION_RATIO,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR,
};
use crate::math_error;
use crate::state::market::Market;

use crate::math::position::_calculate_base_asset_value_and_pnl;

use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn terminal_price(market: &mut Market) -> ClearingHouseResult<u128> {
    let swap_direction = if market.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_quote_asset_amount, new_base_asset_amount) = amm::calculate_swap_output(
        market.base_asset_amount.unsigned_abs(),
        market.amm.base_asset_reserve,
        swap_direction,
        market.amm.sqrt_k,
    )?;

    let terminal_price = amm::calculate_price(
        new_quote_asset_amount,
        new_base_asset_amount,
        market.amm.peg_multiplier,
    )?;

    Ok(terminal_price)
}

pub fn repeg(
    market: &mut Market,
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
    clock_slot: u64,
) -> ClearingHouseResult<i128> {
    if new_peg_candidate == market.amm.peg_multiplier {
        return Err(ErrorCode::InvalidRepegRedundant.into());
    }

    // Find the net market value before adjusting k
    let (current_net_market_value, _) =
        _calculate_base_asset_value_and_pnl(market.base_asset_amount, 0, &market.amm)?;
    let terminal_price_before = terminal_price(market)?;

    market.amm.peg_multiplier = new_peg_candidate;

    let terminal_price_after = terminal_price(market)?;
    let (_new_net_market_value, adjustment_cost) = _calculate_base_asset_value_and_pnl(
        market.base_asset_amount,
        current_net_market_value,
        &market.amm,
    )?;

    let (oracle_price, _oracle_twap, oracle_conf, _oracle_twac, _oracle_delay) =
        market.amm.get_oracle_price(price_oracle, clock_slot)?;

    let oracle_is_valid = false; //todo

    // amm::is_oracle_valid(amm, oracle_account_info, clock_slot, &guard_rails.validity)?;
    // if oracle is valid: check on size/direction of repeg
    if oracle_is_valid {
        // only repeg up to bottom of oracle confidence band
        if cast_to_u128(oracle_price)? > terminal_price_after {
            if !(terminal_price_after > terminal_price_before
                && cast_to_u128(oracle_price)?
                    .checked_sub(oracle_conf)
                    .ok_or_else(math_error!())?
                    > terminal_price_after)
            {
                return Err(ErrorCode::InvalidRepegDirection.into());
            }
        }
        // only repeg down to top of oracle confidence band
        if cast_to_u128(oracle_price)? < terminal_price_after {
            if !(terminal_price_after < terminal_price_before
                && cast_to_u128(oracle_price)?
                    .checked_add(oracle_conf)
                    .ok_or_else(math_error!())?
                    < terminal_price_after)
            {
                return Err(ErrorCode::InvalidRepegDirection.into());
            }
        }
    }

    // Reduce pnl to quote asset precision and take the absolute value
    if adjustment_cost > 0 {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_sub(adjustment_cost.unsigned_abs())
            .or(Some(0))
            .ok_or_else(math_error!())?;

        // Only a portion of the protocol fees are allocated to repegging
        // This checks that the total_fee_minus_distributions does not decrease too much after repeg
        if market.amm.total_fee_minus_distributions
            < market
                .amm
                .total_fee
                .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
                .ok_or_else(math_error!())?
                .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
                .ok_or_else(math_error!())?
        {
            return Err(ErrorCode::InvalidRepegProfitability.into());
        }
    } else {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(adjustment_cost.unsigned_abs())
            .ok_or_else(math_error!())?;
    }

    Ok(adjustment_cost)
}
