use crate::controller;
use crate::error::*;
use crate::math::casting::cast;
use crate::math_error;
use crate::state::history::deposit::{DepositDirection, DepositRecord};
use crate::state::{
    history::{deposit::DepositHistory, funding_payment::FundingPaymentHistory},
    market::Markets,
    state::State,
    user::{User, UserPositions},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use solana_program::msg;

pub fn deposit<'info>(
    amount: u64,
    state: &Account<State>,
    user: &mut Account<'info, User>,
    user_positions: &AccountLoader<'info, UserPositions>,
    markets: &AccountLoader<'info, Markets>,
    funding_payment_history: &AccountLoader<'info, FundingPaymentHistory>,
    deposit_history: &AccountLoader<'info, DepositHistory>,
    token_program: &Program<'info, Token>,
    depositor_token_account: &Account<'info, TokenAccount>,
    collateral_vault: &Account<'info, TokenAccount>,
    depositor: &Signer<'info>,
) -> ProgramResult {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    if amount == 0 {
        return Err(ErrorCode::InsufficientDeposit.into());
    }

    let collateral_before = user.collateral;
    let cumulative_deposits_before = user.cumulative_deposits;

    user.collateral = user
        .collateral
        .checked_add(cast(amount)?)
        .ok_or_else(math_error!())?;
    user.cumulative_deposits = user
        .cumulative_deposits
        .checked_add(cast(amount)?)
        .ok_or_else(math_error!())?;

    let markets = &markets.load()?;
    let user_positions = &mut user_positions.load_mut()?;
    let funding_payment_history = &mut funding_payment_history.load_mut()?;
    controller::funding::settle_funding_payment(
        user,
        user_positions,
        markets,
        funding_payment_history,
        now,
    )?;

    controller::token::receive(
        token_program,
        depositor_token_account,
        collateral_vault,
        depositor,
        amount,
    )?;

    let deposit_history = &mut deposit_history.load_mut()?;
    let record_id = deposit_history.next_record_id();
    deposit_history.append(DepositRecord {
        ts: now,
        record_id,
        user_authority: user.authority,
        user: user.to_account_info().key(),
        direction: DepositDirection::DEPOSIT,
        collateral_before,
        cumulative_deposits_before,
        amount,
    });

    if state.max_deposit > 0 && user.cumulative_deposits > cast(state.max_deposit)? {
        return Err(ErrorCode::UserMaxDeposit.into());
    }

    Ok(())
}
