use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct OrderState {
    pub order_history: Pubkey,
    pub order_filler_reward_structure: OrderFillerRewardStructure,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct OrderFillerRewardStructure {
    pub reward_numerator: u128,
    pub reward_denominator: u128,
}
