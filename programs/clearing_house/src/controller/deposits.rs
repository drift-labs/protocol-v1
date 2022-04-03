use crate::controller::funding::settle_funding_payment;
use crate::controller::token::{receive, send};
use crate::error::*;
use crate::math::casting::{cast, cast_to_u128};
use crate::math::margin::meets_initial_margin_requirement;
use crate::math::withdrawal::calculate_withdrawal_amounts;
use crate::math_error;
use crate::state::history::deposit::{DepositDirection, DepositHistory, DepositRecord};
use crate::state::history::funding_payment::FundingPaymentHistory;
use crate::state::market::Markets;
use crate::state::state::State;
use crate::state::user::{User, UserPositions};
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use solana_program::msg;

pub fn deposit_collateral<'info>(
    amount: u64,
    state: &State,
    authority: &Signer<'info>,
    user: &mut Box<Account<User>>,
    user_positions: &mut AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    token_program: &Program<'info, Token>,
    user_collateral_account: &Account<'info, TokenAccount>,
    collateral_vault: &Account<'info, TokenAccount>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    deposit_history: &AccountLoader<DepositHistory>,
    clock: &Clock,
) -> ProgramResult {
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
    settle_funding_payment(user, user_positions, markets, funding_payment_history, now)?;

    receive(
        token_program,
        user_collateral_account,
        collateral_vault,
        authority,
        amount,
    )?;

    let deposit_history = &mut deposit_history.load_mut()?;
    let record_id = deposit_history.next_record_id();
    deposit_history.append(DepositRecord {
        ts: now,
        record_id,
        user_authority: user.authority,
        user: user.to_account_info().key(),
        direction: DepositDirection::Deposit,
        collateral_before,
        cumulative_deposits_before,
        amount,
    });

    if state.max_deposit > 0 && user.cumulative_deposits > cast(state.max_deposit)? {
        return Err(ErrorCode::UserMaxDeposit.into());
    }

    Ok(())
}

pub fn withdraw_collateral<'info>(
    amount: u64,
    state: &State,
    user: &mut Box<Account<User>>,
    user_positions: &mut AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    token_program: &Program<'info, Token>,
    user_collateral_account: &Account<'info, TokenAccount>,
    collateral_vault: &Account<'info, TokenAccount>,
    collateral_vault_authority: &AccountInfo<'info>,
    insurance_vault: &Account<'info, TokenAccount>,
    insurance_vault_authority: &AccountInfo<'info>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    deposit_history: &AccountLoader<DepositHistory>,
    clock: &Clock,
) -> ProgramResult {
    let now = clock.unix_timestamp;

    let collateral_before = user.collateral;
    let cumulative_deposits_before = user.cumulative_deposits;

    let markets = &markets.load()?;
    let user_positions = &mut user_positions.load_mut()?;
    let funding_payment_history = &mut funding_payment_history.load_mut()?;
    settle_funding_payment(user, user_positions, markets, funding_payment_history, now)?;

    if cast_to_u128(amount)? > user.collateral {
        return Err(ErrorCode::InsufficientCollateral.into());
    }

    let (collateral_account_withdrawal, insurance_account_withdrawal) =
        calculate_withdrawal_amounts(amount, collateral_vault, insurance_vault)?;

    // amount_withdrawn can be less than amount if there is an insufficient balance in collateral and insurance vault
    let amount_withdraw = collateral_account_withdrawal
        .checked_add(insurance_account_withdrawal)
        .ok_or_else(math_error!())?;

    user.cumulative_deposits = user
        .cumulative_deposits
        .checked_sub(cast(amount_withdraw)?)
        .ok_or_else(math_error!())?;

    user.collateral = user
        .collateral
        .checked_sub(cast(collateral_account_withdrawal)?)
        .ok_or_else(math_error!())?
        .checked_sub(cast(insurance_account_withdrawal)?)
        .ok_or_else(math_error!())?;

    if !meets_initial_margin_requirement(user, user_positions, markets)? {
        return Err(ErrorCode::InsufficientCollateral.into());
    }

    send(
        token_program,
        collateral_vault,
        user_collateral_account,
        collateral_vault_authority,
        state.collateral_vault_nonce,
        collateral_account_withdrawal,
    )?;

    if insurance_account_withdrawal > 0 {
        send(
            token_program,
            insurance_vault,
            user_collateral_account,
            insurance_vault_authority,
            state.insurance_vault_nonce,
            insurance_account_withdrawal,
        )?;
    }

    let deposit_history = &mut deposit_history.load_mut()?;
    let record_id = deposit_history.next_record_id();
    deposit_history.append(DepositRecord {
        ts: now,
        record_id,
        user_authority: user.authority,
        user: user.to_account_info().key(),
        direction: DepositDirection::Withdraw,
        collateral_before,
        cumulative_deposits_before,
        amount: amount_withdraw,
    });

    Ok(())
}

pub fn transfer_collateral(
    amount: u64,
    from_user: &mut Box<Account<User>>,
    from_user_positions: &mut AccountLoader<UserPositions>,
    to_user: &mut Box<Account<User>>,
    to_user_positions: &mut AccountLoader<UserPositions>,
    markets: &AccountLoader<Markets>,
    funding_payment_history: &AccountLoader<FundingPaymentHistory>,
    deposit_history: &AccountLoader<DepositHistory>,
    clock: &Clock,
) -> ProgramResult {
    let now = clock.unix_timestamp;

    let from_user_collateral_before = from_user.collateral;
    let from_user_cumulative_deposits_before = from_user.cumulative_deposits;

    let markets = &markets.load()?;
    let from_user_positions = &mut from_user_positions.load_mut()?;
    let funding_payment_history = &mut funding_payment_history.load_mut()?;
    settle_funding_payment(
        from_user,
        from_user_positions,
        markets,
        funding_payment_history,
        now,
    )?;

    if cast_to_u128(amount)? > from_user.collateral {
        return Err(ErrorCode::InsufficientCollateral.into());
    }

    from_user.cumulative_deposits = from_user
        .cumulative_deposits
        .checked_sub(cast(amount)?)
        .ok_or_else(math_error!())?;

    from_user.collateral = from_user
        .collateral
        .checked_sub(cast(amount)?)
        .ok_or_else(math_error!())?;

    if !meets_initial_margin_requirement(from_user, from_user_positions, markets)? {
        return Err(ErrorCode::InsufficientCollateral.into());
    }

    let deposit_history = &mut deposit_history.load_mut()?;
    let record_id = deposit_history.next_record_id();
    deposit_history.append(DepositRecord {
        ts: now,
        record_id,
        user_authority: from_user.authority,
        user: from_user.to_account_info().key(),
        direction: DepositDirection::TransferOut,
        collateral_before: from_user_collateral_before,
        cumulative_deposits_before: from_user_cumulative_deposits_before,
        amount,
    });

    let to_user_collateral_before = to_user.collateral;
    let to_user_cumulative_deposits_before = to_user.cumulative_deposits;

    to_user.collateral = to_user
        .collateral
        .checked_add(cast(amount)?)
        .ok_or_else(math_error!())?;
    to_user.cumulative_deposits = to_user
        .cumulative_deposits
        .checked_add(cast(amount)?)
        .ok_or_else(math_error!())?;

    let to_user_positions = &mut to_user_positions.load_mut()?;
    settle_funding_payment(
        to_user,
        to_user_positions,
        markets,
        funding_payment_history,
        now,
    )?;

    let record_id = deposit_history.next_record_id();
    deposit_history.append(DepositRecord {
        ts: now,
        record_id,
        user_authority: to_user.authority,
        user: to_user.to_account_info().key(),
        direction: DepositDirection::TransferIn,
        collateral_before: to_user_collateral_before,
        cumulative_deposits_before: to_user_cumulative_deposits_before,
        amount,
    });

    Ok(())
}
