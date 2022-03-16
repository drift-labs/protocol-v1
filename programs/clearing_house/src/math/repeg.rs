use crate::controller::amm::SwapDirection;
use crate::error::*;
use crate::math::amm;
use crate::math::amm::calculate_swap_output;
use crate::math::bn;
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO, MARK_PRICE_PRECISION, PEG_PRECISION,
    PRICE_TO_PEG_PRECISION_RATIO, QUOTE_PRECISION,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR,
};
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::math_error;
use crate::state::market::{Market, OraclePriceData, AMM};
use std::cmp::{max, min};

use crate::state::state::OracleGuardRails;
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn calculate_repeg_validity_full(
    market: &mut Market,
    oracle_account_info: &AccountInfo,
    terminal_price_before: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<(bool, bool, bool, bool, i128)> {
    let oracle_price_data = market
        .amm
        .get_oracle_price(oracle_account_info, clock_slot)?;
    let oracle_is_valid = amm::is_oracle_valid(&oracle_price_data, &oracle_guard_rails.validity)?;

    let (
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence_pct_after,
    ) = calculate_repeg_validity(
        market,
        &oracle_price_data,
        oracle_is_valid,
        terminal_price_before,
    )?;

    Ok((
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence_pct_after,
    ))
}

pub fn calculate_repeg_validity(
    market: &mut Market,
    oracle_price_data: &OraclePriceData,
    oracle_is_valid: bool,
    terminal_price_before: u128,
) -> ClearingHouseResult<(bool, bool, bool, bool, i128)> {
    let OraclePriceData {
        price: oracle_price,
        twap: oracle_twap,
        confidence: oracle_conf,
        twap_confidence: oracle_twap_conf,
        delay: oracle_delay,
    } = *oracle_price_data;

    let oracle_price_u128 = cast_to_u128(oracle_price)?;

    let terminal_price_after = amm::calculate_terminal_price(market)?;
    let oracle_terminal_spread_after = oracle_price
        .checked_sub(cast_to_i128(terminal_price_after)?)
        .ok_or_else(math_error!())?;
    let oracle_terminal_divergence_pct_after = oracle_terminal_spread_after
        .checked_shl(10)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())?;

    let mut direction_valid = true;
    let mut price_impact_valid = true;
    let mut profitability_valid = true;

    // if oracle is valid: check on size/direction of repeg
    if oracle_is_valid {
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
            }

            // only push terminal up to top of oracle confidence band
            if oracle_conf_band_bottom < terminal_price_after {
                profitability_valid = false;
            }

            // only push mark up to top of oracle confidence band
            if mark_price_after > oracle_conf_band_top {
                price_impact_valid = false;
            }
        } else if oracle_price_u128 < terminal_price_after {
            // only allow terminal down when oracle is lower
            if terminal_price_after > terminal_price_before {
                direction_valid = false;
            }

            // only push terminal down to top of oracle confidence band
            if oracle_conf_band_top > terminal_price_after {
                profitability_valid = false;
            }

            // only push mark down to bottom of oracle confidence band
            if mark_price_after < oracle_conf_band_bottom {
                price_impact_valid = false;
            }
        }
    } else {
        direction_valid = false;
        price_impact_valid = false;
        profitability_valid = false;
    }

    Ok((
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence_pct_after,
    ))
}

pub fn calculate_peg_from_target_price(
    quote_asset_reserve: u128,
    base_asset_reserve: u128,
    target_price: u128,
) -> ClearingHouseResult<u128> {
    // m = y*C*PTPPR/x
    // C = m*x/y*PTPPR

    let new_peg = bn::U192::from(target_price)
        .checked_mul(bn::U192::from(base_asset_reserve))
        .ok_or_else(math_error!())?
        .checked_div(bn::U192::from(quote_asset_reserve))
        .ok_or_else(math_error!())?
        .checked_mul(bn::U192::from(PRICE_TO_PEG_PRECISION_RATIO))
        .ok_or_else(math_error!())?
        .try_to_u128()?;
    Ok(new_peg)
}

pub fn calculate_optimal_peg_and_cost(
    market: &mut Market,
    oracle_price: i128,
    mark_price: u128,
    terminal_price: u128,
) -> ClearingHouseResult<(u128, i128, &mut Market)> {
    // does minimum valid repeg allowable iff satisfies the budget

    // let fspr = (oracle - mark) - (oracle_twap - mark_twap)

    let oracle_mark_spread = oracle_price
        .checked_sub(cast_to_i128(mark_price)?)
        .ok_or_else(math_error!())?;
    let oracle_mark_spread_pct = oracle_mark_spread
        .checked_shl(10)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())?;

    let oracle_terminal_spread = oracle_price
        .checked_sub(cast_to_i128(terminal_price)?)
        .ok_or_else(math_error!())?;
    let oracle_terminal_spread_pct = oracle_terminal_spread
        .checked_shl(10)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())?;

    let ten_pct = 1_u128
        .checked_shl(10)
        .ok_or_else(math_error!())?
        .checked_div(10)
        .ok_or_else(math_error!())?;

    if (oracle_terminal_spread_pct.unsigned_abs() < ten_pct
        || oracle_terminal_spread.unsigned_abs() < PEG_PRECISION)
        && (oracle_mark_spread_pct.unsigned_abs() < ten_pct
            || oracle_mark_spread.unsigned_abs() < PEG_PRECISION)
    {
        // terminate early, no repeg needed
        return Ok((market.amm.peg_multiplier, 0, market));
    }

    // find optimal peg
    let optimal_peg: u128;
    let current_peg = market.amm.peg_multiplier;

    // max budget for single repeg is half of fee pool for repegs
    let budget = calculate_fee_pool(market)?
        .checked_div(2)
        .ok_or_else(math_error!())?;

    // let max_peg_delta = cast_to_u128(oracle_mark_spread)?
    //     .checked_mul(PEG_PRECISION)
    //     .ok_or_else(math_error!())?
    //     .checked_div(MARK_PRICE_PRECISION)
    //     .ok_or_else(math_error!())?
    //     .checked_div(2)
    //     .ok_or_else(math_error!())?;
    // let min_peg_delta = 1_u128;

    // repeg is profitable when:
    // 1) oracle above both mark and terminal AND terminal at/above mark
    // 2) oracle below both mark and terminal AND terminal at/below mark
    if (oracle_mark_spread > 0 && oracle_terminal_spread > 0 && terminal_price >= mark_price)
        || (oracle_mark_spread < 0 && oracle_terminal_spread < 0 && terminal_price >= mark_price)
    {
        optimal_peg = calculate_peg_from_target_price(
            market.amm.quote_asset_reserve,
            market.amm.base_asset_reserve,
            cast_to_u128(oracle_price)?,
        )?;
    } else if oracle_terminal_spread > 0 && oracle_mark_spread > 0 {
        // oracle is above terminal price
        optimal_peg = current_peg.checked_add(1).ok_or_else(math_error!())?;
    } else if oracle_terminal_spread < 0 && oracle_mark_spread < 0 {
        // oracle is below terminal price
        optimal_peg = current_peg.checked_sub(1).ok_or_else(math_error!())?;
    } else {
        optimal_peg = current_peg;
    }

    let (repegged_market, marginal_adjustment_cost) = adjust_peg_cost(market, optimal_peg)?;

    let candidate_peg: u128;
    let candidate_cost: i128;
    if marginal_adjustment_cost > 0 && marginal_adjustment_cost.unsigned_abs() > budget {
        candidate_peg = current_peg;
        candidate_cost = 0;
    } else {
        candidate_peg = optimal_peg;
        candidate_cost = marginal_adjustment_cost;
    }

    Ok((candidate_peg, candidate_cost, repegged_market))
}

pub fn calculate_budgeted_peg(
    market: &mut Market,
    budget: u128,
    current_price: u128,
    target_price: u128,
) -> ClearingHouseResult<(u128, i128, &mut Market)> {
    // calculates peg_multiplier that changing to would cost no more than budget

    let order_swap_direction = if market.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };

    let (new_quote_asset_amount, _new_base_asset_amount) = calculate_swap_output(
        market.base_asset_amount.unsigned_abs(),
        market.amm.base_asset_reserve,
        order_swap_direction,
        market.amm.sqrt_k,
    )?;

    let optimal_peg = calculate_peg_from_target_price(
        market.amm.quote_asset_reserve,
        market.amm.base_asset_reserve,
        target_price,
    )?;

    let full_budget_peg: u128 = if new_quote_asset_amount != market.amm.quote_asset_reserve {
        let delta_quote_asset_reserves = market
            .amm
            .quote_asset_reserve
            .checked_sub(new_quote_asset_amount)
            .ok_or_else(math_error!())?;

        let delta_peg_multiplier = budget
            .checked_mul(MARK_PRICE_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(
                delta_quote_asset_reserves
                    .checked_div(AMM_TO_QUOTE_PRECISION_RATIO)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?
            .checked_mul(PEG_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(QUOTE_PRECISION)
            .ok_or_else(math_error!())?;

        let delta_peg_precision = delta_peg_multiplier
            .checked_mul(PEG_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(MARK_PRICE_PRECISION)
            .ok_or_else(math_error!())?;

        market
            .amm
            .peg_multiplier
            .checked_sub(delta_peg_precision)
            .ok_or_else(math_error!())?
    } else {
        optimal_peg
    };

    let candidate_peg: u128 = if current_price > target_price {
        min(full_budget_peg, optimal_peg)
    } else {
        max(full_budget_peg, optimal_peg)
    };

    let (repegged_market, candidate_cost) = adjust_peg_cost(market, optimal_peg)?;

    Ok((candidate_peg, candidate_cost, repegged_market))
}

pub fn adjust_peg_cost(
    market: &mut Market,
    new_peg_candidate: u128,
) -> ClearingHouseResult<(&mut Market, i128)> {
    let market_deep_copy = market;

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

    Ok((market_deep_copy, cost))
}

pub fn calculate_fee_pool(market: &Market) -> ClearingHouseResult<u128> {
    let total_fee_minus_distributions_lower_bound = total_fee_lower_bound(&market)?;

    let fee_pool = market
        .amm
        .total_fee_minus_distributions
        .checked_sub(total_fee_minus_distributions_lower_bound)
        .ok_or_else(math_error!())?;

    Ok(fee_pool)
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
