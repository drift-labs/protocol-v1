use crate::error::ClearingHouseResult;
use crate::math::bn::U128;

use crate::error::*;
use crate::math::casting::cast_to_i128;
use crate::math_error;
use num_traits::ToPrimitive;
use solana_program::msg;

pub fn multiply_u128(a: u128, b: u128) -> Option<u128> {
    U128::from(a).checked_mul(U128::from(b))?.try_to_u128().ok()
}

pub fn multiply_i128(a: i128, b: i128) -> Option<i128> {
    U128::from(a.unsigned_abs())
        .checked_mul(U128::from(b.unsigned_abs()))?
        .try_to_u128()
        .ok()?
        .to_i128()
        .map(|c| c * a.signum() * b.signum())
}
