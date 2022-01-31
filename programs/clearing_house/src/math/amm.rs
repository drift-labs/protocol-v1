use std::cmp::{max, min};

use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

use crate::controller::amm::SwapDirection;
use crate::error::*;
use crate::math::bn;
use crate::math::bn::U192;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use crate::math::constants::{MARK_PRICE_PRECISION, PRICE_TO_PEG_PRECISION_RATIO};
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::math::quote_asset::{asset_to_reserve_amount, reserve_to_asset_amount};
use crate::math_error;
use crate::state::market::{Market, AMM};
use crate::state::state::{PriceDivergenceGuardRails, ValidityGuardRails};

pub fn calculate_price(
    quote_asset_reserve: u128,
    base_asset_reserve: u128,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    let peg_quote_asset_amount = quote_asset_reserve
        .checked_mul(peg_multiplier)
        .ok_or_else(math_error!())?;

    return U192::from(peg_quote_asset_amount)
        .checked_mul(U192::from(PRICE_TO_PEG_PRECISION_RATIO))
        .ok_or_else(math_error!())?
        .checked_div(U192::from(base_asset_reserve))
        .ok_or_else(math_error!())?
        .try_to_u128();
}

pub fn calculate_terminal_price(market: &mut Market) -> ClearingHouseResult<u128> {
    let swap_direction = if market.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_quote_asset_amount, new_base_asset_amount) = calculate_swap_output(
        market.base_asset_amount.unsigned_abs(),
        market.amm.base_asset_reserve,
        swap_direction,
        market.amm.sqrt_k,
    )?;

    let terminal_price = calculate_price(
        new_quote_asset_amount,
        new_base_asset_amount,
        market.amm.peg_multiplier,
    )?;

    Ok(terminal_price)
}

pub fn update_mark_twap(
    amm: &mut AMM,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<u128> {
    let mark_twap = calculate_new_mark_twap(amm, now, precomputed_mark_price)?;
    amm.last_mark_price_twap = mark_twap;
    amm.last_mark_price_twap_ts = now;

    return Ok(mark_twap);
}

pub fn calculate_new_mark_twap(
    amm: &AMM,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<u128> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_mark_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        1,
        cast_to_i128(amm.funding_period)?
            .checked_sub(since_last)
            .ok_or_else(math_error!())?,
    );
    let current_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => amm.mark_price()?,
    };

    let new_twap: u128 = cast(calculate_twap(
        cast(current_price)?,
        cast(amm.last_mark_price_twap)?,
        since_last,
        from_start,
    )?)?;

    return Ok(new_twap);
}

pub fn update_oracle_price_twap(
    amm: &mut AMM,
    now: i64,
    oracle_price: i128,
) -> ClearingHouseResult<i128> {
    let new_oracle_price_spread = oracle_price
        .checked_sub(amm.last_oracle_price_twap)
        .ok_or_else(math_error!())?;

    // cap new oracle update to 33% delta from twap
    let oracle_price_33pct = oracle_price.checked_div(3).ok_or_else(math_error!())?;

    let capped_oracle_update_price =
        if new_oracle_price_spread.unsigned_abs() > oracle_price_33pct.unsigned_abs() {
            if oracle_price > amm.last_oracle_price_twap {
                amm.last_oracle_price_twap
                    .checked_add(oracle_price_33pct)
                    .ok_or_else(math_error!())?
            } else {
                amm.last_oracle_price_twap
                    .checked_sub(oracle_price_33pct)
                    .ok_or_else(math_error!())?
            }
        } else {
            oracle_price
        };

    // sanity check
    let oracle_price_twap: i128;
    if capped_oracle_update_price > 0 && oracle_price > 0 {
        oracle_price_twap = calculate_new_oracle_price_twap(amm, now, capped_oracle_update_price)?;
        amm.last_oracle_price = capped_oracle_update_price;
        amm.last_oracle_price_twap = oracle_price_twap;
        amm.last_oracle_price_twap_ts = now;
    } else {
        oracle_price_twap = amm.last_oracle_price_twap
    }

    return Ok(oracle_price_twap);
}

pub fn calculate_new_oracle_price_twap(
    amm: &AMM,
    now: i64,
    oracle_price: i128,
) -> ClearingHouseResult<i128> {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(amm.last_oracle_price_twap_ts)
            .ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        1,
        cast_to_i128(amm.funding_period)?
            .checked_sub(since_last)
            .ok_or_else(math_error!())?,
    );

    // ensure amm.last_oracle_price is proper
    let capped_last_oracle_price = if amm.last_oracle_price > 0 {
        amm.last_oracle_price
    } else {
        oracle_price
    };

    // nudge last_oracle_price up to .1% toward oracle price
    let capped_last_oracle_price_10bp = capped_last_oracle_price
        .checked_div(1000)
        .ok_or_else(math_error!())?;

    let interpolated_oracle_price = min(
        capped_last_oracle_price
            .checked_add(capped_last_oracle_price_10bp)
            .ok_or_else(math_error!())?,
        max(
            capped_last_oracle_price
                .checked_sub(capped_last_oracle_price_10bp)
                .ok_or_else(math_error!())?,
            oracle_price,
        ),
    );

    let new_twap = calculate_twap(
        interpolated_oracle_price,
        amm.last_oracle_price_twap,
        since_last,
        from_start,
    )?;

    return Ok(new_twap);
}

pub fn calculate_twap(
    new_data: i128,
    old_data: i128,
    new_weight: i128,
    old_weight: i128,
) -> ClearingHouseResult<i128> {
    let denominator = new_weight
        .checked_add(old_weight)
        .ok_or_else(math_error!())?;
    let prev_twap_99 = old_data.checked_mul(old_weight).ok_or_else(math_error!())?;
    let latest_price_01 = new_data.checked_mul(new_weight).ok_or_else(math_error!())?;
    let new_twap = prev_twap_99
        .checked_add(latest_price_01)
        .ok_or_else(math_error!())?
        .checked_div(denominator)
        .ok_or_else(math_error!());
    return new_twap;
}

pub fn calculate_swap_output(
    swap_amount: u128,
    input_asset_amount: u128,
    direction: SwapDirection,
    invariant_sqrt: u128,
) -> ClearingHouseResult<(u128, u128)> {
    let invariant_sqrt_u192 = U192::from(invariant_sqrt);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    let new_input_amount = if let SwapDirection::Add = direction {
        input_asset_amount
            .checked_add(swap_amount)
            .ok_or_else(math_error!())?
    } else {
        input_asset_amount
            .checked_sub(swap_amount)
            .ok_or_else(math_error!())?
    };

    let new_input_amount_u192 = U192::from(new_input_amount);
    let new_output_amount = invariant
        .checked_div(new_input_amount_u192)
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    return Ok((new_output_amount, new_input_amount));
}

pub fn calculate_quote_asset_amount_swapped(
    quote_asset_reserve_before: u128,
    quote_asset_reserve_after: u128,
    swap_direction: SwapDirection,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    let quote_asset_reserve_change = match swap_direction {
        SwapDirection::Add => quote_asset_reserve_before
            .checked_sub(quote_asset_reserve_after)
            .ok_or_else(math_error!())?,

        SwapDirection::Remove => quote_asset_reserve_after
            .checked_sub(quote_asset_reserve_before)
            .ok_or_else(math_error!())?,
    };

    reserve_to_asset_amount(quote_asset_reserve_change, peg_multiplier)
}

pub fn calculate_oracle_mark_spread(
    amm: &AMM,
    price_oracle: &AccountInfo,
    window: u32,
    clock_slot: u64,
    precomputed_mark_price: Option<u128>,
    normalise: bool,
) -> ClearingHouseResult<(i128, i128)> {
    let mark_price: i128;
    let mark_price_1bp: i128;

    let (oracle_price, oracle_twap, _oracle_conf, _oracle_twac, _oracle_delay) =
        amm.get_oracle_price(price_oracle, clock_slot)?;

    let oracle_processed: i128;

    if window > 0 {
        mark_price = cast_to_i128(amm.last_mark_price_twap)?;
        mark_price_1bp = mark_price.checked_div(10000).ok_or_else(math_error!())?;
        let conf_int = cast_to_i128(_oracle_twac)?;

        oracle_processed = if normalise {
            if mark_price > oracle_twap {
                min(
                    max(
                        mark_price
                            .checked_sub(mark_price_1bp)
                            .ok_or_else(math_error!())?,
                        oracle_twap,
                    ),
                    oracle_twap
                        .checked_add(conf_int)
                        .ok_or_else(math_error!())?,
                )
            } else {
                max(
                    min(
                        mark_price
                            .checked_add(mark_price_1bp)
                            .ok_or_else(math_error!())?,
                        oracle_twap,
                    ),
                    oracle_twap
                        .checked_sub(conf_int)
                        .ok_or_else(math_error!())?,
                )
            }
        } else {
            oracle_twap
        };

        // don't use processed, only used for divergence spread check
        let price_spread = mark_price
            .checked_sub(oracle_twap)
            .ok_or_else(math_error!())?;

        Ok((oracle_processed, price_spread))
    } else {
        mark_price = match precomputed_mark_price {
            Some(mark_price) => cast_to_i128(mark_price)?,
            None => cast_to_i128(amm.mark_price()?)?,
        };

        // normalises oracle toward mark price based on the oracle's confidence interval
        //  if mark above oracle: use oracle+conf unless it exceeds .9999 * mark price
        //  if mark below oracle: use oracle-conf unless it less than 1.0001 * mark price
        //  (this guarantees more reasonable funding rates in volatile periods)
        oracle_processed = if normalise {
            mark_price_1bp = mark_price.checked_div(10000).ok_or_else(math_error!())?;
            let conf_int = cast_to_i128(_oracle_conf)?;

            if mark_price > oracle_price {
                min(
                    max(
                        mark_price
                            .checked_sub(mark_price_1bp)
                            .ok_or_else(math_error!())?,
                        oracle_price,
                    ),
                    oracle_price
                        .checked_add(conf_int)
                        .ok_or_else(math_error!())?,
                )
            } else {
                max(
                    min(
                        mark_price
                            .checked_add(mark_price_1bp)
                            .ok_or_else(math_error!())?,
                        oracle_price,
                    ),
                    oracle_price
                        .checked_sub(conf_int)
                        .ok_or_else(math_error!())?,
                )
            }
        } else {
            oracle_price
        };

        // don't use processed, only used for divergence spread check
        let price_spread = mark_price
            .checked_sub(oracle_price)
            .ok_or_else(math_error!())?;

        assert_eq!(oracle_processed > 0, true);

        Ok((oracle_processed, price_spread))
    }
}

pub fn calculate_oracle_mark_spread_pct(
    amm: &AMM,
    price_oracle: &AccountInfo,
    window: u32,
    clock_slot: u64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(i128, i128, i128)> {
    let (oracle_price, price_spread) = calculate_oracle_mark_spread(
        amm,
        price_oracle,
        window,
        clock_slot,
        precomputed_mark_price,
        true,
    )?;
    let price_spread_pct = price_spread
        .checked_shl(10)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())?;

    Ok((oracle_price, price_spread, price_spread_pct))
}

pub fn is_oracle_mark_too_divergent(
    price_spread_pct: i128,
    oracle_guard_rails: &PriceDivergenceGuardRails,
) -> ClearingHouseResult<bool> {
    let max_divergence = oracle_guard_rails
        .mark_oracle_divergence_numerator
        .checked_shl(10)
        .ok_or_else(math_error!())?
        .checked_div(oracle_guard_rails.mark_oracle_divergence_denominator)
        .ok_or_else(math_error!())?;

    Ok(price_spread_pct.unsigned_abs() > max_divergence)
}

pub fn is_oracle_valid(
    amm: &AMM,
    price_oracle: &AccountInfo,
    clock_slot: u64,
    valid_oracle_guard_rails: &ValidityGuardRails,
) -> ClearingHouseResult<bool> {
    let (oracle_price, oracle_twap, oracle_conf, oracle_twap_conf, oracle_delay) =
        amm.get_oracle_price(price_oracle, clock_slot)?;

    let is_oracle_price_nonpositive = (oracle_twap <= 0) || (oracle_price <= 0);

    let is_oracle_price_too_volatile = ((oracle_price
        .checked_div(max(1, oracle_twap))
        .ok_or_else(math_error!())?)
    .gt(&valid_oracle_guard_rails.too_volatile_ratio))
        || ((oracle_twap
            .checked_div(max(1, oracle_price))
            .ok_or_else(math_error!())?)
        .gt(&valid_oracle_guard_rails.too_volatile_ratio));

    let conf_denom_of_price = cast_to_u128(oracle_price)?
        .checked_div(max(1, oracle_conf))
        .ok_or_else(math_error!())?;
    let conf_denom_of_twap_price = cast_to_u128(oracle_twap)?
        .checked_div(max(1, oracle_twap_conf))
        .ok_or_else(math_error!())?;
    let is_conf_too_large = (conf_denom_of_price
        .lt(&valid_oracle_guard_rails.confidence_interval_max_size))
        || (conf_denom_of_twap_price.lt(&valid_oracle_guard_rails.confidence_interval_max_size));

    let is_stale = oracle_delay.gt(&valid_oracle_guard_rails.slots_before_stale);

    Ok(!(is_stale
        || is_conf_too_large
        || is_oracle_price_nonpositive
        || is_oracle_price_too_volatile))
}

/// To find the cost of adjusting k, compare the the net market value before and after adjusting k
/// Increasing k costs the protocol money because it reduces slippage and improves the exit price for net market position
/// Decreasing k costs the protocol money because it increases slippage and hurts the exit price for net market position
pub fn adjust_k_cost(market: &mut Market, new_sqrt_k: bn::U256) -> ClearingHouseResult<i128> {
    // Find the net market value before adjusting k
    let (current_net_market_value, _) =
        _calculate_base_asset_value_and_pnl(market.base_asset_amount, 0, &market.amm)?;

    let ratio_scalar = bn::U256::from(MARK_PRICE_PRECISION);

    let sqrt_k_ratio = new_sqrt_k
        .checked_mul(ratio_scalar)
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(market.amm.sqrt_k))
        .ok_or_else(math_error!())?;

    // if decreasing k, max decrease ratio for single transaction is 2.5%
    if sqrt_k_ratio
        < ratio_scalar
            .checked_mul(bn::U256::from(975))
            .ok_or_else(math_error!())?
            .checked_div(bn::U256::from(1000))
            .ok_or_else(math_error!())?
    {
        return Err(ErrorCode::InvalidUpdateK.into());
    }

    market.amm.sqrt_k = new_sqrt_k.try_to_u128().unwrap();
    market.amm.base_asset_reserve = bn::U256::from(market.amm.base_asset_reserve)
        .checked_mul(sqrt_k_ratio)
        .ok_or_else(math_error!())?
        .checked_div(ratio_scalar)
        .ok_or_else(math_error!())?
        .try_to_u128()
        .unwrap();
    market.amm.quote_asset_reserve = bn::U256::from(market.amm.quote_asset_reserve)
        .checked_mul(sqrt_k_ratio)
        .ok_or_else(math_error!())?
        .checked_div(ratio_scalar)
        .ok_or_else(math_error!())?
        .try_to_u128()
        .unwrap();

    let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
        market.base_asset_amount,
        current_net_market_value,
        &market.amm,
    )?;

    Ok(cost)
}

pub fn should_round_trade(
    amm: &AMM,
    quote_asset_amount: u128,
    base_asset_value: u128,
) -> ClearingHouseResult<bool> {
    let difference = if quote_asset_amount > base_asset_value {
        quote_asset_amount
            .checked_sub(base_asset_value)
            .ok_or_else(math_error!())?
    } else {
        base_asset_value
            .checked_sub(quote_asset_amount)
            .ok_or_else(math_error!())?
    };

    let quote_asset_reserve_amount = asset_to_reserve_amount(difference, amm.peg_multiplier)?;

    return Ok(quote_asset_reserve_amount < amm.minimum_trade_size);
}
