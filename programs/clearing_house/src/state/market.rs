use std::convert::TryInto;

use anchor_lang::prelude::*;
use switchboard_aggregator::AggregatorAccountData;

use crate::error::*;
use crate::math::amm;
use crate::math::casting::{cast, cast_to_i128, cast_to_i64, cast_to_u128};
use crate::math_error;
use crate::MARK_PRICE_PRECISION;
use solana_program::msg;

use super::state::OracleGuardRails;

#[cfg(feature = "mainnet-beta")]
const PYTH: Pubkey =
    anchor_lang::solana_program::pubkey!("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");
#[cfg(not(feature = "mainnet-beta"))]
const PYTH: Pubkey =
    anchor_lang::solana_program::pubkey!("gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s");

#[cfg(feature = "mainnet-beta")]
const SWITCHBOARD: Pubkey =
    anchor_lang::solana_program::pubkey!("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f");
#[cfg(not(feature = "mainnet-beta"))]
const SWITCHBOARD: Pubkey =
    anchor_lang::solana_program::pubkey!("2TfB33aLaneQb5TNVwyDz3jSZXS6jdW2ARw1Dgf84XCG");

#[account(zero_copy)]
pub struct Markets {
    pub markets: [Market; 64],
}

impl Default for Markets {
    fn default() -> Self {
        Markets {
            markets: [Market::default(); 64],
        }
    }
}

impl Markets {
    pub fn index_from_u64(index: u64) -> usize {
        std::convert::TryInto::try_into(index).unwrap()
    }

    pub fn get_market(&self, index: u64) -> &Market {
        &self.markets[Markets::index_from_u64(index)]
    }

    pub fn get_market_mut(&mut self, index: u64) -> &mut Market {
        &mut self.markets[Markets::index_from_u64(index)]
    }
}

#[zero_copy]
#[derive(Default)]
pub struct Market {
    pub initialized: bool,
    pub base_asset_amount_long: i128,
    pub base_asset_amount_short: i128,
    pub base_asset_amount: i128, // net market bias
    pub open_interest: u128,     // number of users in a position
    pub amm: AMM,

    // upgrade-ability
    pub padding0: u128,
    pub padding1: u128,
    pub padding2: u128,
    pub padding3: u128,
    pub padding4: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum OracleSource {
    Pyth,
    Switchboard,
}

impl Default for OracleSource {
    // UpOnly
    fn default() -> Self {
        OracleSource::Pyth
    }
}

#[zero_copy]
#[derive(Default)]
pub struct AMM {
    pub oracle: Pubkey,
    pub oracle_source: OracleSource,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
    pub cumulative_repeg_rebate_long: u128,
    pub cumulative_repeg_rebate_short: u128,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub last_funding_rate: i128,
    pub last_funding_rate_ts: i64,
    pub funding_period: i64,
    pub last_oracle_price_twap: i128,
    pub last_mark_price_twap: u128,
    pub last_mark_price_twap_ts: i64,
    pub sqrt_k: u128,
    pub peg_multiplier: u128,
    pub total_fee: u128,
    pub total_fee_minus_distributions: u128,
    pub total_fee_withdrawn: u128,
    pub minimum_quote_asset_trade_size: u128,
    pub last_oracle_price_twap_ts: i64,
    pub last_oracle_price: i128,
    pub minimum_base_asset_trade_size: u128,

    // upgrade-ability
    pub padding1: u64,
    pub padding2: u128,
    pub padding3: u128,
}

impl AMM {
    pub fn new(
        oracle: &AccountInfo,
        amm_base_asset_reserve: u128,
        amm_quote_asset_reserve: u128,
        amm_periodicity: i64,
        amm_peg_multiplier: u128,
        now: i64,
        clock_slot: u64,
    ) -> ClearingHouseResult<Self> {
        let init_mark_price = amm::calculate_price(
            amm_quote_asset_reserve,
            amm_base_asset_reserve,
            amm_peg_multiplier,
        )?;

        msg!("oracle owner = {:?}", oracle.owner.to_string());
        let oracle_source = match *oracle.owner {
            SWITCHBOARD => {
                msg!("oracle source is switchboard");
                OracleSource::Switchboard
            }
            PYTH => {
                msg!("oracle source is pyth");
                OracleSource::Pyth
            }
            _ => {
                msg!("unknown oracle source, defaulting to pyth");
                OracleSource::Pyth
            }
        };

        // Verify oracle is readable
        let (oracle_price, oracle_price_twap, _, _, _) =
            get_oracle_price(oracle_source, oracle, clock_slot).unwrap();

        Ok(AMM {
            oracle: oracle.key(),
            oracle_source: oracle_source,
            base_asset_reserve: amm_base_asset_reserve,
            quote_asset_reserve: amm_quote_asset_reserve,
            cumulative_repeg_rebate_long: 0,
            cumulative_repeg_rebate_short: 0,
            cumulative_funding_rate_long: 0,
            cumulative_funding_rate_short: 0,
            last_funding_rate: 0,
            last_funding_rate_ts: now,
            funding_period: amm_periodicity,
            last_oracle_price_twap: oracle_price_twap,
            last_mark_price_twap: init_mark_price,
            last_mark_price_twap_ts: now,
            sqrt_k: amm_base_asset_reserve,
            peg_multiplier: amm_peg_multiplier,
            total_fee: 0,
            total_fee_withdrawn: 0,
            total_fee_minus_distributions: 0,
            minimum_quote_asset_trade_size: 10000000,
            last_oracle_price_twap_ts: now,
            last_oracle_price: oracle_price,
            minimum_base_asset_trade_size: 10000000,
            padding1: 0,
            padding2: 0,
            padding3: 0,
        })
    }

    pub fn mark_price(&self) -> ClearingHouseResult<u128> {
        amm::calculate_price(
            self.quote_asset_reserve,
            self.base_asset_reserve,
            self.peg_multiplier,
        )
    }

    pub fn get_oracle_price(
        &self,
        price_oracle: &AccountInfo,
        clock_slot: u64,
    ) -> ClearingHouseResult<(i128, i128, u128, u128, i64)> {
        get_oracle_price(self.oracle_source, price_oracle, clock_slot)
    }
}

fn get_oracle_price(
    oracle_source: OracleSource,
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> ClearingHouseResult<(i128, i128, u128, u128, i64)> {
    let (oracle_px, oracle_twap, oracle_conf, oracle_twac, oracle_delay) = match oracle_source {
        OracleSource::Pyth => get_pyth_price(price_oracle, clock_slot)?,
        OracleSource::Switchboard => get_switchboard_price(price_oracle, clock_slot)?,
    };
    Ok((
        oracle_px,
        oracle_twap,
        oracle_conf,
        oracle_twac,
        oracle_delay,
    ))
}

fn get_pyth_price(
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> ClearingHouseResult<(i128, i128, u128, u128, i64)> {
    let pyth_price_data = price_oracle
        .try_borrow_data()
        .or(Err(ErrorCode::UnableToLoadOracle))?;
    let price_data = pyth_client::cast::<pyth_client::Price>(&pyth_price_data);

    let oracle_price = cast_to_i128(price_data.agg.price)?;
    let oracle_conf = cast_to_u128(price_data.agg.conf)?;
    let oracle_twap = cast_to_i128(price_data.twap.val)?;
    let oracle_twac = cast_to_u128(price_data.twac.val)?;

    let oracle_precision = 10_u128.pow(price_data.expo.unsigned_abs());

    let mut oracle_scale_mult = 1;
    let mut oracle_scale_div = 1;

    if oracle_precision > MARK_PRICE_PRECISION {
        oracle_scale_div = oracle_precision
            .checked_div(MARK_PRICE_PRECISION)
            .ok_or_else(math_error!())?;
    } else {
        oracle_scale_mult = MARK_PRICE_PRECISION
            .checked_div(oracle_precision)
            .ok_or_else(math_error!())?;
    }

    let oracle_price_scaled = (oracle_price)
        .checked_mul(cast(oracle_scale_mult)?)
        .ok_or_else(math_error!())?
        .checked_div(cast(oracle_scale_div)?)
        .ok_or_else(math_error!())?;

    let oracle_twap_scaled = (oracle_twap)
        .checked_mul(cast(oracle_scale_mult)?)
        .ok_or_else(math_error!())?
        .checked_div(cast(oracle_scale_div)?)
        .ok_or_else(math_error!())?;

    let oracle_conf_scaled = (oracle_conf)
        .checked_mul(oracle_scale_mult)
        .ok_or_else(math_error!())?
        .checked_div(oracle_scale_div)
        .ok_or_else(math_error!())?;

    let oracle_twac_scaled = (oracle_twac)
        .checked_mul(oracle_scale_mult)
        .ok_or_else(math_error!())?
        .checked_div(oracle_scale_div)
        .ok_or_else(math_error!())?;

    let oracle_delay: i64 = cast_to_i64(clock_slot)?
        .checked_sub(cast(price_data.valid_slot)?)
        .ok_or_else(math_error!())?;

    Ok((
        oracle_price_scaled,
        oracle_twap_scaled,
        oracle_conf_scaled,
        oracle_twac_scaled,
        oracle_delay,
    ))
}

fn get_switchboard_price(
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> ClearingHouseResult<(i128, i128, u128, u128, i64)> {
    let price_data =
        AggregatorAccountData::new(price_oracle).or(Err(ErrorCode::UnableToLoadOracle))?;

    let oracle_price = price_data
        .get_result()
        .or(Err(ErrorCode::UnableToLoadOracle))?;
    let oracle_price_scaled = scale(
        oracle_price.mantissa,
        10_u128.pow(oracle_price.scale),
        MARK_PRICE_PRECISION,
    )?;

    let oracle_conf = price_data.latest_confirmed_round.std_deviation;
    let oracle_conf_scaled = scale(
        oracle_conf.mantissa,
        10_u128.pow(oracle_conf.scale),
        MARK_PRICE_PRECISION,
    )?
    .try_into()
    .or(Err(ErrorCode::InvalidOracle))?;

    let oracle_delay: i64 = cast_to_i64(clock_slot)?
        .checked_sub(cast(price_data.latest_confirmed_round.round_open_slot)?)
        .ok_or_else(math_error!())?;

    // Switchboard doesn't provide twap data, but we don't actually need it since
    // we calculate/store it ourselves elsewhere.
    let oracle_twap = 0i128;
    // Ditto, but we actually don't use the twac, period.
    let oracle_twac = 0u128;

    Ok((
        oracle_price_scaled,
        oracle_twap,
        oracle_conf_scaled,
        oracle_twac,
        oracle_delay,
    ))
}

/// Given a decimal number represented as a mantissa (the digits) plus an
/// original_precision (10.pow(some number of decimals)), scale the
/// mantissa/digits to make sense with a new_precision.
fn scale(
    mantissa: i128,
    original_precision: u128,
    new_precision: u128,
) -> ClearingHouseResult<i128> {
    let mut scale_mult = 1;
    let mut scale_div = 1;

    if original_precision > new_precision {
        scale_div = original_precision
            .checked_div(new_precision)
            // .ok_or_else(math_error!())?;
            .unwrap()
    } else {
        scale_mult = new_precision
            .checked_div(original_precision)
            // .ok_or_else(math_error!())?;
            .unwrap()
    }

    mantissa
        .checked_mul(scale_mult as i128)
        .ok_or_else(math_error!())?
        .checked_div(scale_div as i128)
        .ok_or_else(math_error!())
}

fn _decimal_scale(mantissa: i128, original_decimals: u32, new_decimals: u32) -> i128 {
    if new_decimals > original_decimals {
        mantissa
            .checked_mul(10i128.pow(new_decimals - original_decimals))
            .unwrap()
    } else {
        mantissa
            .checked_div(10i128.pow(original_decimals - new_decimals))
            .unwrap()
    }
}

#[test]
fn test_scaling_decimal_numbers() {
    // 1 -> 1
    assert_eq!(_decimal_scale(1, 0, 0), 1);
    assert_eq!(scale(1, 10u128.pow(0), 10u128.pow(0)).unwrap(), 1);

    // 1 -> 1.0
    assert_eq!(_decimal_scale(1, 0, 1), 10);
    assert_eq!(scale(1, 10u128.pow(0), 10u128.pow(1)).unwrap(), 10);

    // .1 -> .100
    assert_eq!(_decimal_scale(1, 1, 3), 100);
    assert_eq!(scale(1, 10u128.pow(1), 10u128.pow(3)).unwrap(), 100);

    // 0.123 -> 0.12
    assert_eq!(_decimal_scale(123, 3, 2), 12);
    assert_eq!(scale(123, 10u128.pow(3), 10u128.pow(2)).unwrap(), 12);

    // 0.129 -> 0.12
    assert_eq!(_decimal_scale(129, 3, 2), 12);
    assert_eq!(scale(129, 10u128.pow(3), 10u128.pow(2)).unwrap(), 12);
}
