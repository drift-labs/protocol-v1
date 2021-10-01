use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct State {
    pub admin: Pubkey,
    pub admin_controls_prices: bool,
    pub collateral_vault: Pubkey,
    pub collateral_vault_authority: Pubkey,
    pub collateral_vault_nonce: u8,
    pub funding_payment_history: Pubkey,
    pub insurance_vault: Pubkey,
    pub insurance_vault_authority: Pubkey,
    pub insurance_vault_nonce: u8,
    pub markets: Pubkey,
    pub margin_ratio_initial: u128,
    pub margin_ratio_maintenance: u128,
    pub margin_ratio_partial: u128,
    pub partial_liquidation_close_percentage_numerator: u128,
    pub partial_liquidation_close_percentage_denominator: u128,
    pub partial_liquidation_penalty_percentage_numerator: u128,
    pub partial_liquidation_penalty_percentage_denominator: u128,
    pub full_liquidation_penalty_percentage_numerator: u128,
    pub full_liquidation_penalty_percentage_denominator: u128,
    pub partial_liquidation_liquidator_share_denominator: u64,
    pub full_liquidation_liquidator_share_denominator: u64,
    pub fee_numerator: u128,
    pub fee_denominator: u128,
    pub trade_history: Pubkey,
    pub collateral_deposits: u128,
}