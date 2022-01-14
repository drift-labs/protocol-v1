use crate::error::*;
use crate::math::amm;
use crate::math::casting::cast_to_u128;
use crate::math::constants::{
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR,
};
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::math_error;
use crate::state::market::Market;
use crate::state::state::OracleGuardRails;
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn calculate_repeg_validity(
    market: &mut Market,
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<(bool, bool, bool, bool, u128)> {
    let terminal_price_before = amm::calculate_terminal_price(market)?;

    let (oracle_price, _oracle_twap, oracle_conf, _oracle_twac, _oracle_delay) =
        market.amm.get_oracle_price(price_oracle, clock_slot)?;

    let oracle_is_valid = amm::is_oracle_valid(
        &market.amm,
        price_oracle,
        clock_slot,
        &oracle_guard_rails.validity,
    )?;

    let oracle_price_u128 = cast_to_u128(oracle_price)?;

    let mut direction_valid = true;
    let mut price_impact_valid = true;
    let mut profitability_valid = true;

    let oracle_terminal_divergence_pct: u128; // for formulaic repeg

    // if oracle is valid: check on size/direction of repeg
    if oracle_is_valid {
        let terminal_price_after = amm::calculate_terminal_price(market)?;

        let mark_price_after = amm::calculate_price(
            market.amm.quote_asset_reserve,
            market.amm.base_asset_reserve,
            market.amm.peg_multiplier,
        )?;

        let oracle_conf_band_top = oracle_price_u128
            .checked_add(oracle_conf)
            .ok_or_else(math_error!())?;

        let oracle_conf_band_bottom = oracle_price_u128
            .checked_sub(oracle_conf)
            .ok_or_else(math_error!())?;

        if oracle_price_u128 > terminal_price_after {
            // only allow terminal up when oracle is higher
            if terminal_price_after < terminal_price_before {
                direction_valid = false;
                return Err(ErrorCode::InvalidRepegDirection.into());
            }

            // only push terminal up to top of oracle confidence band
            if oracle_conf_band_bottom < terminal_price_after {
                profitability_valid = false;
                return Err(ErrorCode::InvalidRepegProfitability.into());
            }

            // only push mark up to top of oracle confidence band
            if mark_price_after > oracle_conf_band_top {
                price_impact_valid = false;
                return Err(ErrorCode::InvalidRepegPriceImpact.into());
            }

            let oracle_terminal_spread = oracle_price_u128
                .checked_sub(terminal_price_after)
                .ok_or_else(math_error!())?;

            oracle_terminal_divergence_pct = oracle_terminal_spread
                .checked_shl(10)
                .ok_or_else(math_error!())?
                .checked_div(oracle_price_u128)
                .ok_or_else(math_error!())?;
        } else if oracle_price_u128 < terminal_price_after {
            // only allow terminal down when oracle is lower
            if terminal_price_after > terminal_price_before {
                direction_valid = false;
                return Err(ErrorCode::InvalidRepegDirection.into());
            }

            // only push terminal down to top of oracle confidence band
            if oracle_conf_band_top > terminal_price_after {
                profitability_valid = false;
                return Err(ErrorCode::InvalidRepegProfitability.into());
            }

            // only push mark down to bottom of oracle confidence band
            if mark_price_after < oracle_conf_band_bottom {
                price_impact_valid = false;
                return Err(ErrorCode::InvalidRepegPriceImpact.into());
            }

            let oracle_terminal_spread = terminal_price_after
                .checked_sub(oracle_price_u128)
                .ok_or_else(math_error!())?;

            oracle_terminal_divergence_pct = oracle_terminal_spread
                .checked_shl(10)
                .ok_or_else(math_error!())?
                .checked_div(oracle_price_u128)
                .ok_or_else(math_error!())?;
        } else {
            oracle_terminal_divergence_pct = 0;
        }
    } else {
        direction_valid = false;
        price_impact_valid = false;
        profitability_valid = false;
        oracle_terminal_divergence_pct = 0;
    }

    Ok((
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence_pct,
    ))
}

pub fn adjust_peg_cost(market: &mut Market, new_peg_candidate: u128) -> ClearingHouseResult<i128> {
    let market_deep_copy = &mut market.clone();

    // Find the net market value before adjusting peg
    let (current_net_market_value, _) = _calculate_base_asset_value_and_pnl(
        market_deep_copy.base_asset_amount,
        0,
        &market_deep_copy.amm,
    )?;

    market_deep_copy.amm.peg_multiplier = new_peg_candidate;

    let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
        market_deep_copy.base_asset_amount,
        current_net_market_value,
        &market_deep_copy.amm,
    )?;

    Ok(cost)
}

pub fn total_fee_lower_bound(market: &Market) -> ClearingHouseResult<u128> {
    let total_fee_lb = market
        .amm
        .total_fee
        .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
        .ok_or_else(math_error!())?
        .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
        .ok_or_else(math_error!())?;

    Ok(total_fee_lb)
}
