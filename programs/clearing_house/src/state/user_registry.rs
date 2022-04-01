use anchor_lang::prelude::*;

#[account]
pub struct UserRegistry {
    pub authority: Pubkey,
    pub names: [[u8; 32]; 16],
}

impl Default for UserRegistry {
    fn default() -> Self {
        Self {
            authority: Pubkey::default(),
            names: [UNINITIALIZED_NAME; 16],
        }
    }
}

const UNINITIALIZED_NAME: [u8; 32] = [32; 32];

pub fn is_valid_name(name: [u8; 32]) -> bool {
    name != UNINITIALIZED_NAME
}
