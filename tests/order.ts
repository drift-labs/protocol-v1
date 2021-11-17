import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
    Admin,
    MARK_PRICE_PRECISION,
    ClearingHouse,
    PositionDirection,
    UserPositionsAccount
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

describe('orders', () => {
    const provider = anchor.Provider.local();
    const connection = provider.connection;
    anchor.setProvider(provider);
    const chProgram = anchor.workspace.ClearingHouse as Program;

    let clearingHouse: Admin;

    let userAccountPublicKey: PublicKey;

    let usdcMint;
    let userUSDCAccount;

    // ammInvariant == k == x * y
    const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
    const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
        mantissaSqrtScale
    );
    const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
        mantissaSqrtScale
    );

    const usdcAmount = new BN(10 * 10 ** 6);

    let discountMint: Token;
    let discountTokenAccount: AccountInfo;

    before(async () => {
        usdcMint = await mockUSDCMint(provider);
        userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

        clearingHouse = Admin.from(
            connection,
            provider.wallet,
            chProgram.programId
        );
        await clearingHouse.initialize(usdcMint.publicKey, true);
        await clearingHouse.subscribe();

        const solUsd = await mockOracle(1);
        const periodicity = new BN(60 * 60); // 1 HOUR

        await clearingHouse.initializeMarket(
            Markets[0].marketIndex,
            solUsd,
            ammInitialBaseAssetReserve,
            ammInitialQuoteAssetReserve,
            periodicity
        );

        [, userAccountPublicKey] =
            await clearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                userUSDCAccount.publicKey
            );

        discountMint = await Token.createMint(
            connection,
            // @ts-ignore
            provider.wallet.payer,
            provider.wallet.publicKey,
            provider.wallet.publicKey,
            6,
            TOKEN_PROGRAM_ID
        );

        await clearingHouse.updateDiscountMint(discountMint.publicKey);

        discountTokenAccount = await discountMint.getOrCreateAssociatedAccountInfo(
            provider.wallet.publicKey
        );
    });

    after(async () => {
        await clearingHouse.unsubscribe();
    });

    it('Open long order', async () => {
        const amount = new BN(1);
        const price = new BN(1);
        const marketIndex = new BN(0);
        await clearingHouse.updateOrder(PositionDirection.LONG, amount, price, marketIndex);
        const user: any = await clearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );
        const userPositionsAccount: UserPositionsAccount =
            await clearingHouse.program.account.userPositions.fetch(user.positions);
        const firstPosition = userPositionsAccount.positions[0];
        assert(firstPosition.longOrderAmount.eq(amount));
        assert(firstPosition.longOrderPrice.eq(price));
    });
});
