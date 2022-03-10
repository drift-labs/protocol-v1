use crate::error::*;
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math::repeg;

use crate::math::amm;
use crate::math_error;
use crate::state::market::{Market, OraclePriceData, AMM};
use crate::state::state::OracleGuardRails;

use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn repeg(
    market: &mut Market,
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<i128> {
    if new_peg_candidate == market.amm.peg_multiplier {
        return Err(ErrorCode::InvalidRepegRedundant);
    }
    let terminal_price_before = amm::calculate_terminal_price(market)?;

    let (repegged_market, adjustment_cost) = repeg::adjust_peg_cost(market, new_peg_candidate)?;

    let (
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence,
    ) = repeg::calculate_repeg_validity_full(
        repegged_market,
        price_oracle,
        terminal_price_before,
        clock_slot,
        oracle_guard_rails,
    )?;

    // only push terminal in direction of oracle
    if !direction_valid {
        return Err(ErrorCode::InvalidRepegDirection.into());
    }

    // only push terminal up to closer edge of oracle confidence band
    if !profitability_valid {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    // only push mark up to further edge of oracle confidence band
    if !price_impact_valid {
        return Err(ErrorCode::InvalidRepegPriceImpact.into());
    }

    // modify market's total fee change and peg change

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
        if market.amm.total_fee_minus_distributions < repeg::total_fee_lower_bound(&market)? {
            return Err(ErrorCode::InvalidRepegProfitability.into());
        }
    } else {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(adjustment_cost.unsigned_abs())
            .ok_or_else(math_error!())?;
    }

    market.amm.peg_multiplier = new_peg_candidate;

    Ok(adjustment_cost)
}

pub fn formulaic_repeg(
    market: &mut Market,
    precomputed_mark_price: u128,
    oracle_price_data: &OraclePriceData,
    oracle_is_valid: bool,
) -> ClearingHouseResult<i128> {
    let OraclePriceData {
        price: oracle_price,
        twap: oracle_twap,
        confidence: oracle_conf,
        twap_confidence: oracle_twap_conf,
        delay: oracle_delay,
    } = *oracle_price_data;

    let terminal_price_before = amm::calculate_terminal_price(market)?;
    let oracle_terminal_spread_before = oracle_price
        .checked_sub(cast_to_i128(terminal_price_before)?)
        .ok_or_else(math_error!())?;
    // let oracle_terminal_divergence_pct_before = oracle_terminal_spread_before
    //     .checked_shl(10)
    //     .ok_or_else(math_error!())?
    //     .checked_div(oracle_price)
    //     .ok_or_else(math_error!())?;

    let (new_peg_candidate, adjustment_cost, repegged_market) =
        repeg::calculate_optimal_peg_and_cost(
            market,
            oracle_price,
            precomputed_mark_price,
            terminal_price_before,
        )?;

    let (
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        _oracle_terminal_divergence_pct_after,
    ) = repeg::calculate_repeg_validity(
        repegged_market,
        oracle_price_data,
        oracle_is_valid,
        terminal_price_before,
    )?;

    if oracle_is_valid && direction_valid && profitability_valid && price_impact_valid {
        if adjustment_cost > 0 {
            let new_total_fee_minus_distributions = market
                .amm
                .total_fee_minus_distributions
                .checked_sub(adjustment_cost.unsigned_abs())
                .or(Some(0))
                .ok_or_else(math_error!())?;

            if new_total_fee_minus_distributions >= repeg::total_fee_lower_bound(&market)? {
                market.amm.total_fee_minus_distributions = new_total_fee_minus_distributions;
                market.amm.peg_multiplier = new_peg_candidate;
            }
        } else {
            market.amm.total_fee_minus_distributions = market
                .amm
                .total_fee_minus_distributions
                .checked_add(adjustment_cost.unsigned_abs())
                .ok_or_else(math_error!())?;

            market.amm.peg_multiplier = new_peg_candidate;
        }
    }

    Ok(adjustment_cost)
}
