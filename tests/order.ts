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
    ClearingHouseUser, OrderStatus, OrderDiscountTier, OrderRecord, OrderAction, OrderTriggerCondition
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import { mockOracle, mockUSDCMint, mockUserUSDCAccount } from './testHelpers';
import {AMM_RESERVE_PRECISION, ZERO} from "../sdk";
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

    it('Open long limit order', async () => {
        const orderType = OrderType.LIMIT;
        const direction = PositionDirection.LONG;
        const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
        const price = MARK_PRICE_PRECISION.mul(new BN(2));
        const reduceOnly = true;
        const triggerPrice = new BN(0);
        await clearingHouse.placeOrder(orderType, direction, baseAssetAmount, price, marketIndex, reduceOnly, undefined, undefined, discountTokenAccount.address);

        const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
        const order = userOrdersAccount.orders[0];
        const expectedOrderId = new BN(1);

        assert(order.baseAssetAmount.eq(baseAssetAmount));
        assert(order.price.eq(price));
        assert(order.triggerPrice.eq(triggerPrice));
        assert(order.marketIndex.eq(marketIndex));
        assert(order.reduceOnly === reduceOnly);
        assert(enumsAreEqual(order.direction, direction));
        assert(enumsAreEqual(order.status, OrderStatus.OPEN));
        assert(enumsAreEqual(order.discountTier, OrderDiscountTier.FOURTH));
        assert(order.orderId.eq(expectedOrderId));
        assert(order.ts.gt(ZERO));

        const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
        const orderRecord : OrderRecord = orderHistoryAccount.orderRecords[0];
        const expectedRecordId = new BN(1);
        assert(orderRecord.recordId.eq(expectedRecordId));
        assert(orderRecord.ts.gt(ZERO));
        assert(orderRecord.order.orderId.eq(expectedOrderId));
        assert(enumsAreEqual(orderRecord.action, OrderAction.PLACE));
        assert(orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey()));
        assert(orderRecord.authority.equals(clearingHouseUser.authority));
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

        const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
        const orderRecord : OrderRecord = orderHistoryAccount.orderRecords[1];
        const expectedRecordId = new BN(2);
        const expectedOrderId = new BN(1);
        assert(orderRecord.recordId.eq(expectedRecordId));
        assert(orderRecord.ts.gt(ZERO));
        assert(orderRecord.order.orderId.eq(expectedOrderId));
        assert(enumsAreEqual(orderRecord.action, OrderAction.CANCEL));
        assert(orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey()));
        assert(orderRecord.authority.equals(clearingHouseUser.authority));
    });

    it('Fill limit long order', async () => {
        const orderType = OrderType.LIMIT;
        const direction = PositionDirection.LONG;
        const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
        const price = MARK_PRICE_PRECISION.mul(new BN(2));
        await clearingHouse.placeOrder(orderType, direction, baseAssetAmount, price, marketIndex, false, undefined, undefined, discountTokenAccount.address);
        const orderIndex = new BN(0);
        await fillerClearingHouse.fillOrder(userAccountPublicKey, userOrdersAccountPublicKey, orderIndex);

        const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
        const order = userOrdersAccount.orders[orderIndex.toString()];

        const fillerUserAccount = fillerUser.getUserAccount();
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

        const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
        const orderRecord : OrderRecord = orderHistoryAccount.orderRecords[3];
        const expectedRecordId = new BN(4);
        const expectedOrderId = new BN(2);
        const expectedTradeRecordId = new BN(1);
        assert(orderRecord.recordId.eq(expectedRecordId));
        assert(orderRecord.ts.gt(ZERO));
        assert(orderRecord.order.orderId.eq(expectedOrderId));
        assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
        assert(orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey()));
        assert(orderRecord.authority.equals(clearingHouseUser.authority));
        assert(orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey()));
        assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
        assert(orderRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));
        assert(orderRecord.fillerReward.eq(expectedFillerReward));
        assert(orderRecord.tradeRecordId.eq(expectedTradeRecordId));
    });

    it('Fill stop long order', async () => {
        const orderType = OrderType.STOP;
        const direction = PositionDirection.SHORT;
        const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
        const price = new BN(0);
        const triggerPrice = MARK_PRICE_PRECISION;
        const triggerCondition = OrderTriggerCondition.ABOVE;
        await clearingHouse.placeOrder(orderType, direction, baseAssetAmount, price, marketIndex, false, triggerPrice, triggerCondition, discountTokenAccount.address);
        const orderIndex = new BN(0);
        await fillerClearingHouse.fillOrder(userAccountPublicKey, userOrdersAccountPublicKey, orderIndex);

        const userOrdersAccount = clearingHouseUser.getUserOrdersAccount();
        const order = userOrdersAccount.orders[orderIndex.toString()];

        const fillerUserAccount = fillerUser.getUserAccount();
        const expectedFillerReward = new BN(190);
        assert(fillerUserAccount.collateral.sub(usdcAmount).eq(expectedFillerReward));

        const market = clearingHouse.getMarket(marketIndex);
        const expectedFeeToMarket = new BN(1710);
        assert(market.amm.totalFee.eq(expectedFeeToMarket));

        const userAccount = clearingHouseUser.getUserAccount();
        const expectedTokenDiscount = new BN(100);
        assert(userAccount.totalTokenDiscount.eq(expectedTokenDiscount));

        assert(order.baseAssetAmount.eq(new BN(0)));
        assert(order.price.eq(new BN(0)));
        assert(order.marketIndex.eq(new BN(0)));
        assert(enumsAreEqual(order.direction, PositionDirection.LONG));
        assert(enumsAreEqual(order.status, OrderStatus.INIT));

        const userPositionsAccount = clearingHouseUser.getUserPositionsAccount();
        const firstPosition = userPositionsAccount.positions[0];
        const expectedBaseAssetAmount = new BN(0);
        assert(firstPosition.baseAssetAmount.eq(expectedBaseAssetAmount));

        const expectedQuoteAssetAmount = new BN(0);
        assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

        const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
        const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[1];

        assert.ok(tradeHistoryAccount.head.toNumber() === 2);
        assert.ok(
            tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount)
        );
        const expectedTradeQuoteAssetAmount = new BN(1000002);
        assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedTradeQuoteAssetAmount));
        assert.ok(tradeHistoryRecord.markPriceBefore.gt(triggerPrice));

        const orderHistoryAccount = clearingHouse.getOrderHistoryAccount();
        const orderRecord : OrderRecord = orderHistoryAccount.orderRecords[5];
        const expectedRecordId = new BN(6);
        const expectedOrderId = new BN(3);
        const expectedTradeRecordId = new BN(2);
        assert(orderRecord.recordId.eq(expectedRecordId));
        assert(orderRecord.ts.gt(ZERO));
        assert(orderRecord.order.orderId.eq(expectedOrderId));
        assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
        assert(orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey()));
        assert(orderRecord.authority.equals(clearingHouseUser.authority));
        assert(orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey()));
        assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
        assert(orderRecord.quoteAssetAmount.eq(expectedTradeQuoteAssetAmount));
        assert(orderRecord.tradeRecordId.eq(expectedTradeRecordId));
    });
});
