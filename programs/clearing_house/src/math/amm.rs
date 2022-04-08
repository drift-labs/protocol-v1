use std::cmp::{max, min};

use solana_program::msg;

use crate::controller::amm::{AssetType, SwapDirection};
use crate::controller::position::PositionDirection;
use crate::error::*;
use crate::math::bn;
use crate::math::bn::U192;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
use crate::math::constants::{
    MARK_PRICE_PRECISION, PEG_PRECISION, PRICE_SPREAD_PRECISION, PRICE_SPREAD_PRECISION_U128,
    PRICE_TO_PEG_PRECISION_RATIO,
};
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::math::quote_asset::{asset_to_reserve_amount, reserve_to_asset_amount};

use crate::math::cpcurve;
use crate::math::cpsqcurve;
use num_integer::Roots;

use crate::math_error;
use crate::state::market::{Market, OraclePriceData, OracleSource, AMM};
use crate::state::state::{PriceDivergenceGuardRails, ValidityGuardRails};

// todo: should be (x + 1)^2 for low priced coin
pub fn squarify(value: u128, precision: u128) -> ClearingHouseResult<u128> {
    // let half_precision = precision.checked_div(2).ok_or_else(math_error!())?;
    let result: u128;
    // if half_pr ecision > value {
    // msg!("value: {:?}", value);
    result = value
        .checked_mul(value)
        .ok_or_else(math_error!())?
        .checked_div(precision)
        .ok_or_else(math_error!())?;
    // } else {
    //     let value_half_precision = value
    //     .checked_div(half_precision)
    //     .ok_or_else(math_error!())?;
    //     result = value_half_precision
    //     .checked_mul(value_half_precision)
    //     .ok_or_else(math_error!())?;
    // }

    Ok(result)
}

pub fn sqrtify(value: u128, precision: u128) -> ClearingHouseResult<u128> {
    let result = value
        .checked_mul(100_000_000) // 1e8
        .ok_or_else(math_error!())?
        .nth_root(2)
        .checked_div(10_000)
        .ok_or_else(math_error!())?;
    Ok(result)
}

pub fn calculate_price(amm: &AMM) -> ClearingHouseResult<u128> {
    let price = match amm.oracle_source {
        OracleSource::PythSquared => cpsqcurve::calculate_price(
            amm.quote_asset_reserve,
            amm.base_asset_reserve,
            amm.peg_multiplier,
        )?,
        _ => cpcurve::calculate_price(
            amm.quote_asset_reserve,
            amm.base_asset_reserve,
            amm.peg_multiplier,
        )?,
    };
    Ok(price)
}

pub fn calculate_swap_output(
    amm: &AMM,
    swap_amount: u128,
    direction: SwapDirection,
    asset_type: AssetType,
) -> ClearingHouseResult<(u128, u128)> {
    let reserve_swapped = match asset_type {
        AssetType::BASE => amm.base_asset_reserve,
        AssetType::QUOTE => amm.quote_asset_reserve,
    };

    msg!("swap amount: {:?}", swap_amount);

    let (new_output_amount, new_input_amount) = match amm.oracle_source {
        OracleSource::PythSquared => cpsqcurve::calculate_swap_output(
            swap_amount,
            reserve_swapped,
            direction,
            amm.sqrt_k,
            asset_type,
        )?,
        _ => cpcurve::calculate_swap_output(swap_amount, reserve_swapped, direction, amm.sqrt_k)?,
    };
    msg!("swap output worked {:?}", new_output_amount);
    Ok((new_output_amount, new_input_amount))
}

pub fn calculate_market_spread(
    market: &Market,
    mark_price: u128
) -> ClearingHouseResult<u128> {

    let base_spread_unit: u32 = 1_000_000; // 1e6 = 100% of price
    let base_spread = market.price_spread_scalar; // 5bps (500 == .05% of price)
    let base_spread_denom = cast_to_u128(base_spread_unit.checked_div(base_spread).ok_or_else(math_error!())?)?; // 2000
    let spread = mark_price.checked_div(base_spread_denom).ok_or_else(math_error!())?;

    Ok(spread)

}

pub fn calculate_spread_reserve(
    market: &Market,
    precomputed_mark_price: Option<u128>,
    direction: SwapDirection,
    asset_type: AssetType,
) -> ClearingHouseResult<u128> {
    // impl of https://linear.app/driftprotocol/document/formula-for-spread-reserves-f11651521d7f

    let amm = market.amm;

    let reserve = match asset_type {
        AssetType::BASE => amm.base_asset_reserve,
        AssetType::QUOTE => amm.quote_asset_reserve,
    };

    let current_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => amm.mark_price()?,
    };

    // 5 bps
    let spread = calculate_market_spread(market, current_price)?;

    let spread_price = match direction {
        SwapDirection::Add => current_price
            .checked_sub(spread)
            .ok_or_else(math_error!())?,
        SwapDirection::Remove => current_price
            .checked_add(spread)
            .ok_or_else(math_error!())?,
    };

    let spread_reserve_scale_1e4 = match asset_type {
        AssetType::BASE => current_price
            .checked_mul(100_000_000) // 1e8
            .ok_or_else(math_error!())?
            .checked_div(spread_price)
            .ok_or_else(math_error!())?
            .nth_root(2),
        AssetType::QUOTE => spread_price
            .checked_mul(100_000_000) // 1e8
            .ok_or_else(math_error!())?
            .checked_div(current_price)
            .ok_or_else(math_error!())?
            .nth_root(2),
    };

    // f (fraction of reserves to achieve target price)
    let spread_reserve_1e4 = reserve
        .checked_mul(spread_reserve_scale_1e4)
        .ok_or_else(math_error!())?;

    let spread_reserve = spread_reserve_1e4
        .checked_div(10_000) // 1e4 = sqrt(1e8)
        .ok_or_else(math_error!())?;

    Ok(spread_reserve)
}

pub fn calculate_terminal_price_and_reserves(
    market: &Market,
) -> ClearingHouseResult<(u128, u128, u128)> {
    let swap_direction = if market.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (new_quote_asset_amount, new_base_asset_amount) = calculate_swap_output(
        &market.amm,
        market.base_asset_amount.unsigned_abs(),
        swap_direction,
        AssetType::BASE,
    )?;

    let terminal_price = match market.amm.oracle_source {
        OracleSource::PythSquared => cpsqcurve::calculate_price(
            new_quote_asset_amount,
            new_base_asset_amount,
            market.amm.peg_multiplier,
        )?,
        _ => cpcurve::calculate_price(
            new_quote_asset_amount,
            new_base_asset_amount,
            market.amm.peg_multiplier,
        )?,
    };

    Ok((
        terminal_price,
        new_quote_asset_amount,
        new_base_asset_amount,
    ))
}

pub fn calculate_quote_asset_amount_swapped(
    quote_asset_reserve_before: u128,
    quote_asset_reserve_after: u128,
    swap_direction: SwapDirection,
    peg_multiplier: u128,
) -> ClearingHouseResult<u128> {
    msg!(
        "calculate_quote_asset_amount_swapped: {:?}, {:?}",
        quote_asset_reserve_before,
        quote_asset_reserve_after
    );

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

pub fn update_mark_twap(
    amm: &mut AMM,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<u128> {
    let mark_twap = calculate_new_mark_twap(amm, now, precomputed_mark_price)?;
    amm.last_mark_price_twap = mark_twap;
    amm.last_mark_price_twap_ts = now;

    Ok(mark_twap)
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

    let new_twap: u128 = cast(calculate_weighted_average(
        cast(current_price)?,
        cast(amm.last_mark_price_twap)?,
        since_last,
        from_start,
    )?)?;

    Ok(new_twap)
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

    Ok(oracle_price_twap)
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

    let mut interpolated_oracle_price = min(
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

    // if an oracle delay impacted last oracle_twap, shrink toward mark_twap
    interpolated_oracle_price = if amm.last_mark_price_twap_ts > amm.last_oracle_price_twap_ts {
        let since_last_valid = cast_to_i128(
            amm.last_mark_price_twap_ts
                .checked_sub(amm.last_oracle_price_twap_ts)
                .ok_or_else(math_error!())?,
        )?;
        msg!(
            "correcting oracle twap update (oracle previously invalid for {:?} seconds)",
            since_last_valid
        );

        let from_start_valid = max(
            1,
            cast_to_i128(amm.funding_period)?
                .checked_sub(since_last_valid)
                .ok_or_else(math_error!())?,
        );
        calculate_weighted_average(
            cast_to_i128(amm.last_mark_price_twap)?,
            interpolated_oracle_price,
            since_last_valid,
            from_start_valid,
        )?
    } else {
        interpolated_oracle_price
    };

    let new_twap = calculate_weighted_average(
        interpolated_oracle_price,
        amm.last_oracle_price_twap,
        since_last,
        from_start,
    )?;

    Ok(new_twap)
}

pub fn calculate_weighted_average(
    data1: i128,
    data2: i128,
    weight1: i128,
    weight2: i128,
) -> ClearingHouseResult<i128> {
    let denominator = weight1.checked_add(weight2).ok_or_else(math_error!())?;
    let prev_twap_99 = data1.checked_mul(weight1).ok_or_else(math_error!())?;
    let latest_price_01 = data2.checked_mul(weight2).ok_or_else(math_error!())?;

    prev_twap_99
        .checked_add(latest_price_01)
        .ok_or_else(math_error!())?
        .checked_div(denominator)
        .ok_or_else(math_error!())
}

pub fn calculate_oracle_mark_spread(
    amm: &AMM,
    oracle_price_data: &OraclePriceData,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(i128, i128)> {
    let mark_price = match precomputed_mark_price {
        Some(mark_price) => cast_to_i128(mark_price)?,
        None => cast_to_i128(amm.mark_price()?)?,
    };

    let oracle_price = oracle_price_data.price;

    let price_spread = mark_price
        .checked_sub(oracle_price)
        .ok_or_else(math_error!())?;

    Ok((oracle_price, price_spread))
}

pub fn normalise_oracle_price(
    amm: &AMM,
    oracle_price: &OraclePriceData,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        ..
    } = *oracle_price;

    let mark_price = match precomputed_mark_price {
        Some(mark_price) => cast_to_i128(mark_price)?,
        None => cast_to_i128(amm.mark_price()?)?,
    };

    let mark_price_1bp = mark_price.checked_div(10000).ok_or_else(math_error!())?;
    let conf_int = cast_to_i128(oracle_conf)?;

    //  normalises oracle toward mark price based on the oracle’s confidence interval
    //  if mark above oracle: use oracle+conf unless it exceeds .9999 * mark price
    //  if mark below oracle: use oracle-conf unless it less than 1.0001 * mark price
    //  (this guarantees more reasonable funding rates in volatile periods)
    let normalised_price = if mark_price > oracle_price {
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
    };

    Ok(normalised_price)
}

pub fn calculate_oracle_mark_spread_pct(
    amm: &AMM,
    oracle_price_data: &OraclePriceData,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<i128> {
    let (oracle_price, price_spread) =
        calculate_oracle_mark_spread(amm, oracle_price_data, precomputed_mark_price)?;

    price_spread
        .checked_mul(PRICE_SPREAD_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())
}

pub fn is_oracle_mark_too_divergent(
    price_spread_pct: i128,
    oracle_guard_rails: &PriceDivergenceGuardRails,
) -> ClearingHouseResult<bool> {
    let max_divergence = oracle_guard_rails
        .mark_oracle_divergence_numerator
        .checked_mul(PRICE_SPREAD_PRECISION_U128)
        .ok_or_else(math_error!())?
        .checked_div(oracle_guard_rails.mark_oracle_divergence_denominator)
        .ok_or_else(math_error!())?;

    Ok(price_spread_pct.unsigned_abs() > max_divergence)
}

pub fn calculate_mark_twap_spread_pct(amm: &AMM, mark_price: u128) -> ClearingHouseResult<i128> {
    let mark_price = cast_to_i128(mark_price)?;
    let mark_twap = cast_to_i128(amm.last_mark_price_twap)?;

    let price_spread = mark_price
        .checked_sub(mark_twap)
        .ok_or_else(math_error!())?;

    price_spread
        .checked_mul(PRICE_SPREAD_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(mark_twap)
        .ok_or_else(math_error!())
}

pub fn use_oracle_price_for_margin_calculation(
    price_spread_pct: i128,
    oracle_guard_rails: &PriceDivergenceGuardRails,
) -> ClearingHouseResult<bool> {
    let max_divergence = oracle_guard_rails
        .mark_oracle_divergence_numerator
        .checked_mul(PRICE_SPREAD_PRECISION_U128)
        .ok_or_else(math_error!())?
        .checked_div(oracle_guard_rails.mark_oracle_divergence_denominator)
        .ok_or_else(math_error!())?
        .checked_div(3)
        .ok_or_else(math_error!())?;

    Ok(price_spread_pct.unsigned_abs() > max_divergence)
}

pub fn is_oracle_valid(
    amm: &AMM,
    oracle_price_data: &OraclePriceData,
    valid_oracle_guard_rails: &ValidityGuardRails,
) -> ClearingHouseResult<bool> {
    let OraclePriceData {
        price: oracle_price,
        confidence: oracle_conf,
        delay: oracle_delay,
        has_sufficient_number_of_data_points,
        ..
    } = *oracle_price_data;

    let is_oracle_price_nonpositive = oracle_price <= 0;

    let is_oracle_price_too_volatile = ((oracle_price
        .checked_div(max(1, amm.last_oracle_price_twap))
        .ok_or_else(math_error!())?)
    .gt(&valid_oracle_guard_rails.too_volatile_ratio))
        || ((amm
            .last_oracle_price_twap
            .checked_div(max(1, oracle_price))
            .ok_or_else(math_error!())?)
        .gt(&valid_oracle_guard_rails.too_volatile_ratio));

    let conf_denom_of_price = cast_to_u128(oracle_price)?
        .checked_div(max(1, oracle_conf))
        .ok_or_else(math_error!())?;
    let is_conf_too_large =
        conf_denom_of_price.lt(&valid_oracle_guard_rails.confidence_interval_max_size);

    let is_stale = oracle_delay.gt(&valid_oracle_guard_rails.slots_before_stale);

    Ok(!(is_stale
        || !has_sufficient_number_of_data_points
        || is_oracle_price_nonpositive
        || is_oracle_price_too_volatile
        || is_conf_too_large))
}

/// To find the cost of adjusting k, compare the the net market value before and after adjusting k
/// Increasing k costs the protocol money because it reduces slippage and improves the exit price for net market position
/// Decreasing k costs the protocol money because it increases slippage and hurts the exit price for net market position
pub fn adjust_k_cost(market: &mut Market, new_sqrt_k: bn::U256) -> ClearingHouseResult<i128> {
    // Find the net market value before adjusting k
    let (current_net_market_value, _) =
        _calculate_base_asset_value_and_pnl(market.base_asset_amount, 0, &market.amm)?;

    let mark_price_precision = bn::U256::from(MARK_PRICE_PRECISION);

    let sqrt_k_ratio = new_sqrt_k
        .checked_mul(mark_price_precision)
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(market.amm.sqrt_k))
        .ok_or_else(math_error!())?;

    // if decreasing k, max decrease ratio for single transaction is 2.5%
    if sqrt_k_ratio
        < mark_price_precision
            .checked_mul(bn::U256::from(975))
            .ok_or_else(math_error!())?
            .checked_div(bn::U256::from(1000))
            .ok_or_else(math_error!())?
    {
        return Err(ErrorCode::InvalidUpdateK);
    }

    market.amm.sqrt_k = new_sqrt_k.try_to_u128().unwrap();
    market.amm.base_asset_reserve = bn::U256::from(market.amm.base_asset_reserve)
        .checked_mul(sqrt_k_ratio)
        .ok_or_else(math_error!())?
        .checked_div(mark_price_precision)
        .ok_or_else(math_error!())?
        .try_to_u128()
        .unwrap();

    let invariant_sqrt_u192 = U192::from(market.amm.sqrt_k);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    market.amm.quote_asset_reserve = invariant
        .checked_div(U192::from(market.amm.base_asset_reserve))
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

pub fn calculate_max_base_asset_amount_to_trade(
    amm: &AMM,
    limit_price: u128,
) -> ClearingHouseResult<(u128, PositionDirection)> {
    let invariant_sqrt_u192 = U192::from(amm.sqrt_k);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;

    let new_base_asset_reserve_squared = invariant
        .checked_mul(U192::from(MARK_PRICE_PRECISION))
        .ok_or_else(math_error!())?
        .checked_div(U192::from(limit_price))
        .ok_or_else(math_error!())?
        .checked_mul(U192::from(amm.peg_multiplier))
        .ok_or_else(math_error!())?
        .checked_div(U192::from(PEG_PRECISION))
        .ok_or_else(math_error!())?;

    let new_base_asset_reserve = new_base_asset_reserve_squared
        .integer_sqrt()
        .try_to_u128()?;

    if new_base_asset_reserve > amm.base_asset_reserve {
        let max_trade_amount = new_base_asset_reserve
            .checked_sub(amm.base_asset_reserve)
            .ok_or_else(math_error!())?;
        Ok((max_trade_amount, PositionDirection::Short))
    } else {
        let max_trade_amount = amm
            .base_asset_reserve
            .checked_sub(new_base_asset_reserve)
            .ok_or_else(math_error!())?;
        Ok((max_trade_amount, PositionDirection::Long))
    }
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

    Ok(quote_asset_reserve_amount < amm.minimum_quote_asset_trade_size)
}
