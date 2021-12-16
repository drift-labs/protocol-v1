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
    ClearingHouseUser, OrderStatus, OrderDiscountTier
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import {AMM_RESERVE_PRECISION} from "../sdk";
import {AccountInfo, Token, TOKEN_PROGRAM_ID} from "@solana/spl-token";

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
    let userOrdersAccountPublicKey: PublicKey;

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

    const fillerKeyPair = new Keypair();
    let fillerUSDCAccount: Keypair;
    let fillerUserAccountPublicKey: PublicKey;
    let fillerClearingHouse: ClearingHouse;
    let fillerUser: ClearingHouseUser;

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
        await clearingHouse.subscribeToAll();

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

        userOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(clearingHouse.program.programId, provider.wallet.publicKey);

        clearingHouseUser = ClearingHouseUser.from(clearingHouse, provider.wallet.publicKey);
        await clearingHouseUser.subscribe();

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

        await discountMint.mintTo(
            discountTokenAccount.address,
            // @ts-ignore
            provider.wallet.payer,
            [],
            1000 * 10 ** 6
        );

        provider.connection.requestAirdrop(fillerKeyPair.publicKey, 10 ** 9);
        fillerUSDCAccount = await mockUserUSDCAccount(
            usdcMint,
            usdcAmount,
            provider,
            fillerKeyPair.publicKey
        );
        fillerClearingHouse = ClearingHouse.from(
            connection,
            new Wallet(fillerKeyPair),
            chProgram.programId
        );
        await fillerClearingHouse.subscribe();

        [, fillerUserAccountPublicKey] =
            await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                fillerUSDCAccount.publicKey
            );

        fillerUser = ClearingHouseUser.from(fillerClearingHouse, fillerKeyPair.publicKey);
        await fillerUser.subscribe();
    });

    after(async () => {
        await clearingHouse.unsubscribe();
        await clearingHouseUser.unsubscribe();
        await fillerUser.unsubscribe();
    });

    it('Open long order', async () => {
        const orderType = OrderType.LIMIT;
        const direction = PositionDirection.LONG;
        const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
        const price = MARK_PRICE_PRECISION.mul(new BN(2));
        const reduceOnly = true;
        await clearingHouse.placeOrder(orderType, direction, baseAssetAmount, price, marketIndex, reduceOnly, discountTokenAccount.address);

        const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
        const order = userOrdersAccount.orders[0];

        assert(order.baseAssetAmount.eq(baseAssetAmount));
        assert(order.price.eq(price));
        assert(order.marketIndex.eq(marketIndex));
        assert(order.reduceOnly === reduceOnly);
        assert(enumsAreEqual(order.direction, direction));
        assert(enumsAreEqual(order.status, OrderStatus.OPEN));
        assert(enumsAreEqual(order.discountTier, OrderDiscountTier.FOURTH));
    });

    it('Fail to fill reduce only order', async () => {
        const orderIndex = new BN(0);
        try {
            await fillerClearingHouse.fillOrder(userAccountPublicKey, userOrdersAccountPublicKey, orderIndex);
        } catch (e) {
            return;
        }
        assert(false);
    });

    it('Cancel order', async () => {
        const orderIndex = new BN(0);
        await clearingHouse.cancelOrder(orderIndex);

        const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
        const order = userOrdersAccount.orders[orderIndex.toString()];

        assert(order.baseAssetAmount.eq(new BN(0)));
        assert(order.price.eq(new BN(0)));
        assert(order.marketIndex.eq(new BN(0)));
        assert(enumsAreEqual(order.direction, PositionDirection.LONG));
        assert(enumsAreEqual(order.status, OrderStatus.INIT));
    });

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

    it('Fill long order', async () => {
        const orderType = OrderType.LIMIT;
        const direction = PositionDirection.LONG;
        const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
        const price = MARK_PRICE_PRECISION.mul(new BN(2));
        await clearingHouse.placeOrder(orderType, direction, baseAssetAmount, price, marketIndex, false, discountTokenAccount.address);
        const orderIndex = new BN(0);
        await fillerClearingHouse.fillOrder(userAccountPublicKey, userOrdersAccountPublicKey, orderIndex);

        const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
        const order = userOrdersAccount.orders[orderIndex.toString()];

        const fillerUserAccount = fillerUser.getUserAccount();
        console.log(fillerUserAccount.collateral.toString());
        const expectedFillerReward = new BN(95);
        assert(fillerUserAccount.collateral.sub(usdcAmount).eq(expectedFillerReward));

        const market = clearingHouse.getMarket(marketIndex);
        const expectedFeeToMarket = new BN(855);
        assert(market.amm.totalFee.eq(expectedFeeToMarket));

        const userAccount = clearingHouseUser.getUserAccount();
        const expectedTokenDiscount = new BN(50);
        assert(userAccount.totalTokenDiscount.eq(expectedTokenDiscount));

        assert(order.baseAssetAmount.eq(new BN(0)));
        assert(order.price.eq(new BN(0)));
        assert(order.marketIndex.eq(new BN(0)));
        assert(enumsAreEqual(order.direction, PositionDirection.LONG));
        assert(enumsAreEqual(order.status, OrderStatus.INIT));

        const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
        const firstPosition = userPositionsAccount.positions[0];
        assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));

        const expectedQuoteAssetAmount = new BN(1000003);
        assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

        const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
        const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[0];

        assert.ok(tradeHistoryAccount.head.toNumber() === 1);
        assert.ok(
            tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount)
        );
        assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));
    });
});
