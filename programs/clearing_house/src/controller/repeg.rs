use crate::error::*;
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math::repeg;

use crate::math::amm;
use crate::math_error;
use crate::state::market::{Market, OraclePriceData, AMM};
use crate::state::state::OracleGuardRails;
use std::cmp::{max, min};

use crate::math::constants::{AMM_RESERVE_PRECISION, MARK_PRICE_PRECISION, QUOTE_PRECISION};
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn repeg(
    market: &mut Market,
    price_oracle: &AccountInfo,
    new_peg_candidate: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<i128> {
    // for adhoc admin only repeg

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
        _oracle_terminal_divergence,
    ) = repeg::calculate_repeg_validity_from_oracle_account(
        repegged_market,
        price_oracle,
        terminal_price_before,
        clock_slot,
        oracle_guard_rails,
    )?;

    // cannot repeg if oracle is invalid
    if !oracle_is_valid {
        return Err(ErrorCode::InvalidOracle.into());
    }

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
    let cost_applied = apply_cost_to_market(market, adjustment_cost)?;
    if cost_applied {
        market.amm.peg_multiplier = new_peg_candidate;
    } else {
        return Err(ErrorCode::InvalidRepegProfitability.into());
    }

    Ok(adjustment_cost)
}

pub fn formulaic_repeg(
    market: &mut Market,
    precomputed_mark_price: u128,
    oracle_price_data: &OraclePriceData,
    is_oracle_valid: bool,
    fee_budget: u128,
) -> ClearingHouseResult<i128> {
    // backrun market swaps to do automatic on-chain repeg

    if !is_oracle_valid {
        return Ok(0);
    }

    let terminal_price_before = amm::calculate_terminal_price(market)?;
    // let oracle_terminal_spread_before = oracle_price
    //     .checked_sub(cast_to_i128(terminal_price_before)?)
    //     .ok_or_else(math_error!())?;

    // max budget for single repeg what larger of pool budget and user fee budget
    let pool_budget =
        repeg::calculate_pool_budget(market, precomputed_mark_price, oracle_price_data)?;
    let budget = min(fee_budget, pool_budget);

    let (new_peg_candidate, adjustment_cost, repegged_market) = repeg::calculate_budgeted_peg(
        market,
        budget,
        precomputed_mark_price,
        cast_to_u128(oracle_price_data.price)?,
    )?;

    let (
        oracle_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        _oracle_terminal_divergence_pct_after,
    ) = repeg::calculate_repeg_validity(
        repegged_market,
        oracle_price_data,
        is_oracle_valid,
        terminal_price_before,
    )?;

    if oracle_valid && direction_valid && profitability_valid && price_impact_valid {
        let cost_applied = apply_cost_to_market(market, adjustment_cost)?;
        if cost_applied {
            market.amm.peg_multiplier = new_peg_candidate;
        }
    }

    Ok(adjustment_cost)
}

fn apply_cost_to_market(market: &mut Market, cost: i128) -> ClearingHouseResult<bool> {
    // positive cost is expense, negative cost is revenue
    // Reduce pnl to quote asset precision and take the absolute value
    if cost > 0 {
        let new_total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_sub(cost.unsigned_abs())
            .ok_or_else(math_error!())?;

        // Only a portion of the protocol fees are allocated to repegging
        // This checks that the total_fee_minus_distributions does not decrease too much after repeg
        if new_total_fee_minus_distributions > repeg::total_fee_lower_bound(&market)? {
            market.amm.total_fee_minus_distributions = new_total_fee_minus_distributions;
        } else {
            return Ok(false);
        }
    } else {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(cost.unsigned_abs())
            .ok_or_else(math_error!())?;
    }

    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .checked_add(cost as i64)
        .ok_or_else(math_error!())?;

    Ok(true)
}
