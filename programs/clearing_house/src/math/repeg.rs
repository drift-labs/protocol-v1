use crate::error::*;
use crate::math_error;
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::state::market::Market;
use crate::math::constants::{
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR,
};
use solana_program::msg;


pub fn adjust_peg_cost(market: &mut Market, new_peg: u128) -> ClearingHouseResult<i128> {
    // Find the net market value before adjusting peg
    let (current_net_market_value, _) =
        _calculate_base_asset_value_and_pnl(market.base_asset_amount, 0, &market.amm)?;

    market.amm.peg_multiplier = new_peg;

    let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
        market.base_asset_amount,
        current_net_market_value,
        &market.amm,
    )?;

    Ok(cost)
}

pub fn total_fee_lower_bound(market: & Market) -> ClearingHouseResult<u128> {
   let total_fee_lb = market.amm
                .total_fee
                .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
                .ok_or_else(math_error!())?
                .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
                .ok_or_else(math_error!())?;

    Ok(total_fee_lb)
}
