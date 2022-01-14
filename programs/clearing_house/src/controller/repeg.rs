use crate::error::*;
use crate::math::repeg;

use crate::math_error;
use crate::state::market::Market;

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
        return Err(ErrorCode::InvalidRepegRedundant.into());
    }

    let adjustment_cost = repeg::adjust_peg_cost(market, new_peg_candidate)?;

    let (
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence,
    ) = repeg::calculate_repeg_validity(
        market,
        price_oracle,
        new_peg_candidate,
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
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<i128> {
    if new_peg_candidate == market.amm.peg_multiplier {
        return Err(ErrorCode::InvalidRepegRedundant.into());
    }

    let adjustment_cost = repeg::adjust_peg_cost(market, new_peg_candidate)?;

    let (
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence,
    ) = repeg::calculate_repeg_validity(
        market,
        price_oracle,
        new_peg_candidate,
        clock_slot,
        oracle_guard_rails,
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
