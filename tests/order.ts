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
    UserPositionsAccount, OrderType, getUserOrdersAccountPublicKey,
    ClearingHouseUser, OrderStatus
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';

const enumsAreEqual = (actual: Object, expected: Object) : boolean => {
    return JSON.stringify(actual) === JSON.stringify(expected);
}

describe('orders', () => {
    const provider = anchor.Provider.local();
    const connection = provider.connection;
    anchor.setProvider(provider);
    const chProgram = anchor.workspace.ClearingHouse as Program;

    let clearingHouse: Admin;
    let clearingHouseUser: ClearingHouseUser;

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

    const executorKeyPair = new Keypair();
    let executorUSDCAccount: Keypair;
    let executorUserAccountPublicKey: PublicKey;
    let executorClearingHouse: ClearingHouse;

    const marketIndex = new BN(1);

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
        const peg = new BN(1000);

        await clearingHouse.initializeMarket(
            marketIndex,
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

        clearingHouseUser = ClearingHouseUser.from(clearingHouse, provider.wallet.publicKey);
        await clearingHouseUser.subscribe();

        provider.connection.requestAirdrop(executorKeyPair.publicKey, 10 ** 9);
        executorUSDCAccount = await mockUserUSDCAccount(
            usdcMint,
            usdcAmount,
            provider,
            executorKeyPair.publicKey
        );
        executorClearingHouse = ClearingHouse.from(
            connection,
            new Wallet(executorKeyPair),
            chProgram.programId
        );
        await executorClearingHouse.subscribe();

        [, executorUserAccountPublicKey] =
            await executorClearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                executorUSDCAccount.publicKey
            );
    });

    after(async () => {
        await clearingHouse.unsubscribe();
    });

    it('Open long order', async () => {
        const orderType = OrderType.LIMIT;
        const direction = PositionDirection.LONG;
        const baseAssetAmount = new BN(10000000);
        const price = new BN(1);
        await clearingHouse.placeOrder(orderType, direction, baseAssetAmount, price, marketIndex);

        const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
        const order = userOrdersAccount.orders[0];

        assert(order.baseAssetAmount.eq(baseAssetAmount));
        assert(order.price.eq(price));
        assert(order.marketIndex.eq(marketIndex));
        assert(enumsAreEqual(order.direction, direction));
        assert(enumsAreEqual(order.status, OrderStatus.OPEN));
    });

    // it('Cancel long order', async () => {
    //     await clearingHouse.cancelOrder(PositionDirection.LONG, marketIndex);
    //     const user: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     const userPositionsAccount: UserPositionsAccount =
    //         await clearingHouse.program.account.userPositions.fetch(user.positions);
    //     const firstPosition = userPositionsAccount.positions[0];
    //     assert(firstPosition.longOrderAmount.eq(new BN(0)));
    //     assert(firstPosition.longOrderPrice.eq(new BN(0)));
    // });

    // it('Open order with amount that is too small', async () => {
    //     const amount = new BN(1);
    //     const price = new BN(1);
    //     try {
    //         await clearingHouse.placeOrder(PositionDirection.LONG, amount, price, marketIndex);
    //     } catch (e) {
    //         return;
    //     }
    //     assert(false);
    // });

    // it('Open short order', async () => {
    //     const amount = new BN(10000000);
    //     const price = new BN(1);
    //     await clearingHouse.placeOrder(PositionDirection.SHORT, amount, price, marketIndex);
    //     const user: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     const userPositionsAccount: UserPositionsAccount =
    //         await clearingHouse.program.account.userPositions.fetch(user.positions);
    //     const firstPosition = userPositionsAccount.positions[0];
    //     assert(firstPosition.shortOrderAmount.eq(amount));
    //     assert(firstPosition.shortOrderPrice.eq(price));
    // });
    //
    // it('Cancel short order', async () => {
    //     await clearingHouse.cancelOrder(PositionDirection.SHORT, marketIndex);
    //     const user: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     const userPositionsAccount: UserPositionsAccount =
    //         await clearingHouse.program.account.userPositions.fetch(user.positions);
    //     const firstPosition = userPositionsAccount.positions[0];
    //     assert(firstPosition.shortOrderAmount.eq(new BN(0)));
    //     assert(firstPosition.shortOrderPrice.eq(new BN(0)));
    // });
    //
    // it('Fill long order', async () => {
    //     const amount = new BN(AMM_RESERVE_PRECISION);
    //     const price = MARK_PRICE_PRECISION.mul(new BN(2));
    //     await clearingHouse.placeOrder(PositionDirection.LONG, amount, price, marketIndex);
    //     await executorClearingHouse.executeOrder(userAccountPublicKey, marketIndex);
    //
    //     const user: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     const userPositionsAccount: UserPositionsAccount =
    //         await clearingHouse.program.account.userPositions.fetch(user.positions);
    //     const firstPosition = userPositionsAccount.positions[0];
    //     assert(firstPosition.baseAssetAmount.eq(amount));
    // });
});
