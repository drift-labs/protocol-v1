import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
    Admin,
    ClearingHouse,
    MAX_LEVERAGE,
    PositionDirection,
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import {AMM_RESERVE_PRECISION, FeeStructure, UserPositionsAccount} from '../sdk';

describe('round in favor', () => {
    const provider = anchor.Provider.local();
    const connection = provider.connection;
    anchor.setProvider(provider);
    const chProgram = anchor.workspace.ClearingHouse as Program;

    let usdcMint;

    let primaryClearingHouse: Admin;

    // ammInvariant == k == x * y
    const ammInitialQuoteAssetReserve = new anchor.BN(17 * 10 ** 13);
    const ammInitialBaseAssetReserve = new anchor.BN(17 * 10 ** 13);

    const usdcAmount = new BN(9999 * 10 ** 3);

    before(async () => {
        usdcMint = await mockUSDCMint(provider);

        primaryClearingHouse = Admin.from(
            connection,
            provider.wallet,
            chProgram.programId
        );
        await primaryClearingHouse.initialize(usdcMint.publicKey, true);
        await primaryClearingHouse.subscribe();

        const solUsd = await mockOracle(17);
        const periodicity = new BN(60 * 60); // 1 HOUR

        await primaryClearingHouse.initializeMarket(
            Markets[0].marketIndex,
            solUsd,
            ammInitialBaseAssetReserve,
            ammInitialQuoteAssetReserve,
            periodicity,
            new BN(17000)
        );

        const newFeeStructure: FeeStructure = {
            feeNumerator: new BN(0),
            feeDenominator: new BN(1),
            discountTokenTiers: {
                firstTier: {
                    minimumBalance: new BN(1),
                    discountNumerator: new BN(1),
                    discountDenominator: new BN(1),
                },
                secondTier: {
                    minimumBalance: new BN(1),
                    discountNumerator: new BN(1),
                    discountDenominator: new BN(1),
                },
                thirdTier: {
                    minimumBalance: new BN(1),
                    discountNumerator: new BN(1),
                    discountDenominator: new BN(1),
                },
                fourthTier: {
                    minimumBalance: new BN(1),
                    discountNumerator: new BN(1),
                    discountDenominator: new BN(1),
                },
            },
            referralDiscount: {
                referrerRewardNumerator: new BN(1),
                referrerRewardDenominator: new BN(1),
                refereeDiscountNumerator: new BN(1),
                refereeDiscountDenominator: new BN(1),
            },
        };

        await primaryClearingHouse.updateFee(newFeeStructure);
    });

    after(async () => {
        await primaryClearingHouse.unsubscribe();
    });

    it('short', async () => {
        const keypair = new Keypair();
        await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
        const wallet = new Wallet(keypair);
        const userUSDCAccount = await mockUserUSDCAccount(
            usdcMint,
            usdcAmount,
            provider,
            keypair.publicKey
        );
        const clearingHouse = ClearingHouse.from(
            connection,
            wallet,
            chProgram.programId
        );
        await clearingHouse.subscribe();
        const [, userAccountPublicKey] =
            await clearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                userUSDCAccount.publicKey
            );


        const baseAssetAmount = new BN("50000000000")
        const marketIndex = new BN(0);
        await clearingHouse.openPositionWithBaseAsset(
            PositionDirection.SHORT,
            baseAssetAmount,
            marketIndex,
            new BN(0)
        );

        let user: any = await primaryClearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );
        assert(user.collateral.eq(usdcAmount));

        await clearingHouse.closePosition(marketIndex);

        user = await primaryClearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );
        console.log(user.collateral.toString());
        assert(user.collateral.eq(new BN(9998983)));
    });

    it('long', async () => {
        const keypair = new Keypair();
        await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
        const wallet = new Wallet(keypair);
        const userUSDCAccount = await mockUserUSDCAccount(
            usdcMint,
            usdcAmount,
            provider,
            keypair.publicKey
        );
        const clearingHouse = ClearingHouse.from(
            connection,
            wallet,
            chProgram.programId
        );
        await clearingHouse.subscribe();

        const [, userAccountPublicKey] =
            await clearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                userUSDCAccount.publicKey
            );

        const baseAssetAmount = new BN("50000000000");
        const marketIndex = new BN(0);
        await clearingHouse.openPositionWithBaseAsset(
            PositionDirection.LONG,
            baseAssetAmount,
            marketIndex,
            new BN(0)
        );

        let user: any = await primaryClearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );
        assert(user.collateral.eq(usdcAmount));

        await clearingHouse.closePosition(marketIndex);

        user = await primaryClearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );

        console.log(user.collateral.toString());
        assert(user.collateral.eq(new BN(9998983)));
    });
});
