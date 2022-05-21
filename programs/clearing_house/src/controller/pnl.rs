use crate::error::ClearingHouseResult;
use crate::math::casting::cast;
use crate::math::collateral::calculate_updated_collateral;
use crate::math_error;
use crate::state::market::Market;
use crate::state::user::{MarketPosition, User};
use solana_program::msg;
use std::cmp::min;

pub fn update_pnl(
    user: &mut User,
    position: &mut MarketPosition,
    market: &mut Market,
    pnl: i128,
) -> ClearingHouseResult {
    if pnl >= 0 {
        let pnl = pnl.unsigned_abs();
        let realised_pnl = min(pnl, market.amm.available_pnl);
        user.collateral = calculate_updated_collateral(user.collateral, realised_pnl as i128)?;
        let pnl_outstanding = pnl.checked_sub(realised_pnl).ok_or_else(math_error!())?;

        position.pnl_outstanding = position
            .pnl_outstanding
            .checked_add(pnl_outstanding)
            .ok_or_else(math_error!())?;
        market.amm.available_pnl = market
            .amm
            .available_pnl
            .checked_sub(realised_pnl)
            .ok_or_else(math_error!())?;
    } else {
        let outstanding_pnl_lost = min(pnl.unsigned_abs(), position.pnl_outstanding);
        position.pnl_outstanding = position
            .pnl_outstanding
            .checked_sub(outstanding_pnl_lost)
            .ok_or_else(math_error!())?;

        let realised_pnl = pnl
            .checked_add(cast(outstanding_pnl_lost)?)
            .ok_or_else(math_error!())?;
        user.collateral = calculate_updated_collateral(user.collateral, realised_pnl)?;

        market.amm.available_pnl = market
            .amm
            .available_pnl
            .checked_add(realised_pnl.unsigned_abs())
            .ok_or_else(math_error!())?;
    }

    Ok(())
}
