use crate::context::{InitializeUserOptionalAccounts, ManagePositionOptionalAccounts};
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::user::User;
use crate::state::user_orders::UserOrders;
use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::{Account, AccountLoader};
use solana_program::account_info::next_account_info;
use spl_token::solana_program::program_pack::{IsInitialized, Pack};
use spl_token::state::Account as TokenAccount;
use std::slice::Iter;

pub fn get_whitelist_token(
    optional_accounts: InitializeUserOptionalAccounts,
    accounts: &[AccountInfo],
    whitelist_mint: &Pubkey,
) -> ClearingHouseResult<Option<TokenAccount>> {
    if !optional_accounts.whitelist_token {
        return Ok(None);
    }

    if accounts.len() != 1 {
        return Err(ErrorCode::WhitelistTokenNotFound);
    }
    let token_account_info = &accounts[0];

    if token_account_info.owner != &spl_token::id() {
        return Err(ErrorCode::InvalidWhitelistToken);
    }

    let token_account = TokenAccount::unpack_unchecked(&token_account_info.data.borrow())
        .or(Err(ErrorCode::InvalidWhitelistToken))?;

    if !token_account.is_initialized() {
        return Err(ErrorCode::InvalidWhitelistToken);
    }

    if !token_account.mint.eq(whitelist_mint) {
        return Err(ErrorCode::InvalidWhitelistToken);
    }

    Ok(Some(token_account))
}

pub fn get_discount_token_and_referrer<'a, 'b, 'c, 'd, 'e>(
    optional_accounts: ManagePositionOptionalAccounts,
    accounts: &'a [AccountInfo<'b>],
    discount_mint: &'c Pubkey,
    user_public_key: &'d Pubkey,
    authority_public_key: &'e Pubkey,
) -> ClearingHouseResult<(Option<TokenAccount>, Option<Account<'b, User>>)> {
    let account_info_iter = &mut accounts.iter();
    let optional_discount_token = get_discount_token(
        optional_accounts.discount_token,
        account_info_iter,
        discount_mint,
        authority_public_key,
    )?;

    let optional_referrer = get_referrer(
        optional_accounts.referrer,
        account_info_iter,
        user_public_key,
        None,
    )?;

    Ok((optional_discount_token, optional_referrer))
}

pub fn get_discount_token(
    expect_discount_token: bool,
    account_info_iter: &mut Iter<AccountInfo>,
    discount_mint: &Pubkey,
    authority_public_key: &Pubkey,
) -> ClearingHouseResult<Option<TokenAccount>> {
    let mut optional_discount_token = None;
    if expect_discount_token {
        let token_account_info =
            next_account_info(account_info_iter).or(Err(ErrorCode::DiscountTokenNotFound))?;

        if token_account_info.owner != &spl_token::id() {
            return Err(ErrorCode::InvalidDiscountToken);
        }

        let token_account = TokenAccount::unpack_unchecked(&token_account_info.data.borrow())
            .or(Err(ErrorCode::InvalidDiscountToken))?;

        if !token_account.is_initialized() {
            return Err(ErrorCode::InvalidDiscountToken);
        }

        if !token_account.mint.eq(discount_mint) {
            return Err(ErrorCode::InvalidDiscountToken);
        }

        if !token_account.owner.eq(authority_public_key) {
            return Err(ErrorCode::InvalidDiscountToken);
        }

        optional_discount_token = Some(token_account);
    }

    Ok(optional_discount_token)
}

pub fn get_referrer<'a, 'b, 'c, 'd>(
    expect_referrer: bool,
    account_info_iter: &'a mut Iter<AccountInfo<'b>>,
    user_public_key: &'c Pubkey,
    expected_referrer: Option<&'d Pubkey>,
) -> ClearingHouseResult<Option<Account<'b, User>>> {
    let mut optional_referrer = None;
    if expect_referrer {
        let referrer_account_info =
            next_account_info(account_info_iter).or(Err(ErrorCode::ReferrerNotFound))?;

        if referrer_account_info.key.eq(user_public_key) {
            return Err(ErrorCode::UserCantReferThemselves);
        }

        // in get_referrer_for_fill_order, we know who the referrer should be, so add check that the expected
        // referrer is present
        if let Some(expected_referrer) = expected_referrer {
            if !referrer_account_info.key.eq(expected_referrer) {
                return Err(ErrorCode::DidNotReceiveExpectedReferrer);
            }
        }

        let user_account: Account<User> = Account::try_from(referrer_account_info)
            .or(Err(ErrorCode::CouldNotDeserializeReferrer))?;

        optional_referrer = Some(user_account);
    }

    Ok(optional_referrer)
}

pub fn get_referrer_for_fill_order<'a, 'b, 'c>(
    account_info_iter: &'a mut Iter<AccountInfo<'b>>,
    user_public_key: &'c Pubkey,
    order_id: u128,
    user_orders: &AccountLoader<UserOrders>,
) -> ClearingHouseResult<Option<Account<'b, User>>> {
    let user_orders = &user_orders
        .load()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    let order_index = user_orders
        .orders
        .iter()
        .position(|order| order.order_id == order_id)
        .ok_or(ErrorCode::OrderDoesNotExist)?;
    let order = &user_orders.orders[order_index];
    let mut referrer = None;
    if !order.referrer.eq(&Pubkey::default()) {
        referrer = get_referrer(
            true,
            account_info_iter,
            user_public_key,
            Some(&order.referrer),
        )
        .or_else(|error| match error {
            // if we can't deserialize the referrer in fill, assume user account has been deleted and dont fail
            ErrorCode::CouldNotDeserializeReferrer => Ok(None),
            // in every other case fail
            _ => Err(error),
        })?;
    }

    Ok(referrer)
}
