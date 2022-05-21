use crate::error::ClearingHouseResult;
use crate::math_error;
use crate::state::market::Markets;
use anchor_spl::token::TokenAccount;
use solana_program::msg;
use std::cell::Ref;

/// Calculates how much of withdrawal must come from collateral vault and how much comes from insurance vault
pub fn calculate_withdrawal_amounts(
    amount: u64,
    collateral_token_account: &TokenAccount,
    insurance_token_account: &TokenAccount,
    markets: &Ref<Markets>,
) -> ClearingHouseResult<(u64, u64)> {
    let total_fees_minus_distributions: u128 = markets.markets.iter().fold(0, |sum, market| {
        sum.checked_add(market.amm.total_fee_minus_distributions)
            .ok_or_else(math_error!())
            .unwrap()
            .checked_sub(market.amm.total_fee_withdrawn)
            .ok_or_else(math_error!())
            .unwrap()
    });

    let available_collateral_vault_amount = (collateral_token_account.amount as u128)
        .checked_sub(total_fees_minus_distributions)
        .ok_or_else(math_error!())? as u64;

    Ok(if available_collateral_vault_amount >= amount {
        (amount, 0)
    } else if insurance_token_account.amount
        > amount
            .checked_sub(available_collateral_vault_amount)
            .ok_or_else(math_error!())?
    {
        (
            available_collateral_vault_amount,
            amount
                .checked_sub(available_collateral_vault_amount)
                .ok_or_else(math_error!())?,
        )
    } else {
        (
            available_collateral_vault_amount,
            insurance_token_account.amount,
        )
    })
}
