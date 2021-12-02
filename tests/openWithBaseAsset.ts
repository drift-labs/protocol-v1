import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import BN from 'bn.js';

import { Program } from '@project-serum/anchor';
import { getTokenAccount } from '@project-serum/common';

import { PublicKey } from '@solana/web3.js';

import {
    Admin,
    MARK_PRICE_PRECISION,
    calculateMarkPrice,
    calculateTradeSlippage,
    ClearingHouseUser,
    PositionDirection,
    AMM_RESERVE_PRECISION,
    QUOTE_PRECISION,
    MAX_LEVERAGE,
    convertToNumber,
} from '../sdk/src';

import { Markets } from '../sdk/src/constants/markets';

import {
    mockUSDCMint,
    mockUserUSDCAccount,
    mintToInsuranceFund,
    mockOracle,
    setFeedPrice,
} from './testHelpers';

describe('clearing_house', () => {
    const provider = anchor.Provider.local();
    const connection = provider.connection;
    anchor.setProvider(provider);
    const chProgram = anchor.workspace.ClearingHouse as Program;

    let clearingHouse: Admin;

    let userAccountPublicKey: PublicKey;
    let user: ClearingHouseUser;

    let usdcMint;
    let userUSDCAccount;

    // ammInvariant == k == x * y
    const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
    const ammInitialQuoteAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
        mantissaSqrtScale
    );
    const ammInitialBaseAssetAmount = new anchor.BN(5 * 10 ** 13).mul(
        mantissaSqrtScale
    );

    const usdcAmount = new BN(10 * 10 ** 6);

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

        await clearingHouse.initializeMarket(
            Markets[0].marketIndex,
            solUsd,
            ammInitialBaseAssetAmount,
            ammInitialQuoteAssetAmount,
            periodicity
        );

        [, userAccountPublicKey] =
            await clearingHouse.initializeUserAccountAndDepositCollateral(
                usdcAmount,
                userUSDCAccount.publicKey
            );

        user = ClearingHouseUser.from(clearingHouse, provider.wallet.publicKey);
        await user.subscribe();
    });

    after(async () => {
        await clearingHouse.unsubscribe();
        await user.unsubscribe();
    });

    it('Long from 0 position', async () => {
        const marketIndex = new BN(0);
        const baseAssetAmount = AMM_RESERVE_PRECISION;
        await clearingHouse.openPositionWithBaseAsset(
            PositionDirection.LONG,
            baseAssetAmount,
            marketIndex
        );

        const expectedFee = new BN(1000);
        assert(user.getUserAccount().collateral.eq(new BN(9999000)));
        assert(user.getUserAccount().totalFeePaid.eq(expectedFee));

        const expectedQuoteAssetAmount = new BN(1000003);
        const position = user.getUserPosition(marketIndex);
        assert.ok(
            position.quoteAssetAmount.eq(expectedQuoteAssetAmount)
        );
        assert.ok(
            position.baseAssetAmount.eq(baseAssetAmount)
        );

        const market = clearingHouse.getMarket(marketIndex);
        assert.ok(market.baseAssetAmount.eq(baseAssetAmount));
        assert.ok(market.amm.totalFee.eq(expectedFee));
        assert.ok(market.amm.totalFeeMinusDistributions.eq(expectedFee));

        const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
        const tradeHistoryRecord = tradeHistoryAccount.tradeRecords[0];

        assert.ok(tradeHistoryAccount.head.toNumber() === 1);
        assert.ok(
            tradeHistoryRecord.user.equals(userAccountPublicKey)
        );
        assert.ok(tradeHistoryRecord.recordId.eq(new BN(1)));
        assert.ok(
            JSON.stringify(tradeHistoryRecord.direction) ===
            JSON.stringify(PositionDirection.LONG)
        );
        assert.ok(
            tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount)
        );
        assert.ok(tradeHistoryRecord.liquidation == false);
        assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));
        assert.ok(tradeHistoryRecord.marketIndex.eq(marketIndex));
    });

    it('Order fails due to unrealiziable limit price ', async () => {
        try {
            const marketIndex = new BN(0);
            const baseAssetAmount = AMM_RESERVE_PRECISION;
            const limitPrice = MARK_PRICE_PRECISION;
            await clearingHouse.openPositionWithBaseAsset(
                PositionDirection.LONG,
                baseAssetAmount,
                marketIndex,
                limitPrice,
            );
        } catch (e) {
            return;
        }
        assert(false);
    });

    it('Reduce long position', async () => {
        const marketIndex = new BN(0);
        const baseAssetAmount = AMM_RESERVE_PRECISION.div(new BN(2));
        await clearingHouse.openPositionWithBaseAsset(
            PositionDirection.SHORT,
            baseAssetAmount,
            marketIndex
        );

        const position = user.getUserPosition(marketIndex);
        assert.ok(
            position.quoteAssetAmount.eq(new BN(500002))
        );

        const expectedBaseAssetAmount = AMM_RESERVE_PRECISION.div(new BN(2));
        assert.ok(
            position.baseAssetAmount.eq(expectedBaseAssetAmount)
        );
        console.log(user.getUserAccount().collateral.toString());
        assert.ok(user.getUserAccount().collateral.eq(new BN(9998500)));
        const expectedTotalFee = new BN(1500);
        assert(user.getUserAccount().totalFeePaid.eq(expectedTotalFee));

        const marketsAccount = clearingHouse.getMarketsAccount();
        const market: any = marketsAccount.markets[0];
        assert.ok(market.baseAssetAmount.eq(expectedBaseAssetAmount));
        assert.ok(market.amm.totalFee.eq(expectedTotalFee));
        assert.ok(market.amm.totalFeeMinusDistributions.eq(expectedTotalFee));

        const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
        assert.ok(tradeHistoryAccount.head.toNumber() === 2);

        const tradeRecord = tradeHistoryAccount.tradeRecords[1];
        assert.ok(
            tradeRecord.user.equals(userAccountPublicKey)
        );
        assert.ok(tradeRecord.recordId.eq(new BN(2)));
        assert.ok(
            JSON.stringify(tradeRecord.direction) ===
            JSON.stringify(PositionDirection.SHORT)
        );
        assert.ok(
            tradeRecord.baseAssetAmount.eq(
                baseAssetAmount
            )
        );
        assert.ok(tradeHistoryAccount.tradeRecords[1].liquidation == false);
        assert.ok(
            tradeRecord.quoteAssetAmount.eq(new BN(500001))
        );
    });

    it('Reverse long position', async () => {
        const baseAssetAmount = AMM_RESERVE_PRECISION;
        await clearingHouse.openPositionWithBaseAsset(
            PositionDirection.SHORT,
            baseAssetAmount,
            new BN(0)
        );

        const user: any = await clearingHouse.program.account.user.fetch(
            userAccountPublicKey
        );
        const userPositionsAccount: any =
            await clearingHouse.program.account.userPositions.fetch(user.positions);

        console.log(user.collateral.toString());
        console.log(user.totalFeePaid.toString());
        assert.ok(user.collateral.eq(new BN(9998498)));
        assert(user.totalFeePaid.eq(new BN(1500)));
        console.log(userPositionsAccount.positions[0].quoteAssetAmount.toString());
        assert.ok(
            userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(24875001))
        );
        assert.ok(
            userPositionsAccount.positions[0].baseAssetAmount.eq(
                new BN(-248762385929198)
            )
        );

        const marketsAccount = clearingHouse.getMarketsAccount();
        const market: any = marketsAccount.markets[0];
        assert.ok(market.baseAssetAmount.eq(new BN(-248762385929198)));
        assert.ok(market.amm.totalFee.eq(new BN(124375)));
        assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(124375)));

        const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();

        assert.ok(tradeHistoryAccount.head.toNumber() === 3);
        assert.ok(
            tradeHistoryAccount.tradeRecords[2].user.equals(userAccountPublicKey)
        );
        assert.ok(tradeHistoryAccount.tradeRecords[2].recordId.eq(new BN(3)));
        assert.ok(
            JSON.stringify(tradeHistoryAccount.tradeRecords[2].direction) ===
            JSON.stringify(PositionDirection.SHORT)
        );
        console.log(tradeHistoryAccount.tradeRecords[2].baseAssetAmount.toNumber());
        assert.ok(
            tradeHistoryAccount.tradeRecords[2].baseAssetAmount.eq(
                new BN(497500011232339)
            )
        );
        assert.ok(
            tradeHistoryAccount.tradeRecords[2].quoteAssetAmount.eq(new BN(49750000))
        );
        assert.ok(tradeHistoryAccount.tradeRecords[2].marketIndex.eq(new BN(0)));
    });
    //
    // it('Close position', async () => {
    //     await clearingHouse.closePosition(new BN(0));
    //
    //     const user: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     const userPositionsAccount: any =
    //         await clearingHouse.program.account.userPositions.fetch(user.positions);
    //     assert.ok(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
    //     assert.ok(userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(0)));
    //     assert.ok(user.collateral.eq(new BN(9850748)));
    //     assert(user.totalFeePaid.eq(new BN(149250)));
    //
    //     const marketsAccount = clearingHouse.getMarketsAccount();
    //     const market: any = marketsAccount.markets[0];
    //     assert.ok(market.baseAssetAmount.eq(new BN(0)));
    //     assert.ok(market.amm.totalFee.eq(new BN(149250)));
    //     assert.ok(market.amm.totalFeeMinusDistributions.eq(new BN(149250)));
    //
    //     const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
    //
    //     assert.ok(tradeHistoryAccount.head.toNumber() === 4);
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[3].user.equals(userAccountPublicKey)
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[3].recordId.eq(new BN(4)));
    //     assert.ok(
    //         JSON.stringify(tradeHistoryAccount.tradeRecords[3].direction) ===
    //         JSON.stringify(PositionDirection.LONG)
    //     );
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[3].baseAssetAmount.eq(
    //             new BN(248762385929198)
    //         )
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[2].liquidation == false);
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[3].quoteAssetAmount.eq(new BN(24875002))
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[3].marketIndex.eq(new BN(0)));
    // });
    //
    // it('Open short position', async () => {
    //     let user: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     const incrementalUSDCNotionalAmount = calculateTradeAmount(user.collateral);
    //     await clearingHouse.openPosition(
    //         PositionDirection.SHORT,
    //         incrementalUSDCNotionalAmount,
    //         new BN(0)
    //     );
    //
    //     user = await clearingHouse.program.account.user.fetch(userAccountPublicKey);
    //     const userPositionsAccount: any =
    //         await clearingHouse.program.account.userPositions.fetch(user.positions);
    //     assert.ok(
    //         userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(49007471))
    //     );
    //     assert.ok(
    //         userPositionsAccount.positions[0].baseAssetAmount.eq(
    //             new BN(-490122749352851)
    //         )
    //     );
    //
    //     const marketsAccount = clearingHouse.getMarketsAccount();
    //     const market: any = marketsAccount.markets[0];
    //     assert.ok(market.baseAssetAmount.eq(new BN(-490122749352851)));
    //
    //     const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
    //
    //     assert.ok(tradeHistoryAccount.head.toNumber() === 5);
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[4].user.equals(userAccountPublicKey)
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[4].recordId.eq(new BN(5)));
    //     assert.ok(
    //         JSON.stringify(tradeHistoryAccount.tradeRecords[4].direction) ===
    //         JSON.stringify(PositionDirection.SHORT)
    //     );
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[4].baseAssetAmount.eq(
    //             new BN(490122749352851)
    //         )
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[4].liquidation == false);
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[4].quoteAssetAmount.eq(new BN(49007471))
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[4].marketIndex.eq(new BN(0)));
    // });
    //
    // it('Partial Liquidation', async () => {
    //     const marketIndex = new BN(0);
    //
    //     userAccount = ClearingHouseUser.from(
    //         clearingHouse,
    //         provider.wallet.publicKey
    //     );
    //     await userAccount.subscribe();
    //
    //     const user0: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     const userPositionsAccount0: any =
    //         await clearingHouse.program.account.userPositions.fetch(user0.positions);
    //
    //     const liqPrice = userAccount.liquidationPrice(
    //         userPositionsAccount0.positions[0],
    //         new BN(0),
    //         true
    //     );
    //
    //     console.log(
    //         'liqPrice move:',
    //         convertToNumber(calculateMarkPrice(clearingHouse.getMarket(marketIndex))),
    //         '->',
    //         convertToNumber(liqPrice),
    //         'on position',
    //         convertToNumber(
    //             userPositionsAccount0.positions[0].baseAssetAmount,
    //             AMM_RESERVE_PRECISION
    //         ),
    //         'with collateral:',
    //         convertToNumber(user0.collateral, QUOTE_PRECISION)
    //     );
    //
    //     const marketsAccount: any = clearingHouse.getMarketsAccount();
    //     const marketData = marketsAccount.markets[0];
    //     await setFeedPrice(
    //         anchor.workspace.Pyth,
    //         convertToNumber(liqPrice),
    //         marketData.amm.oracle
    //     );
    //
    //     await clearingHouse.moveAmmToPrice(marketIndex, liqPrice);
    //     console.log('margin ratio', userAccount.getMarginRatio().toString());
    //
    //     console.log(
    //         'collateral + pnl post px move:',
    //         convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
    //     );
    //
    //     // having the user liquidate themsevles because I'm too lazy to create a separate liquidator account
    //     await clearingHouse.liquidate(userAccountPublicKey);
    //
    //     console.log(
    //         'collateral + pnl post liq:',
    //         convertToNumber(userAccount.getTotalCollateral(), QUOTE_PRECISION)
    //     );
    //     console.log('can be liquidated', userAccount.canBeLiquidated());
    //     console.log('margin ratio', userAccount.getMarginRatio().toString());
    //
    //     const state: any = clearingHouse.getStateAccount();
    //     const user: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     const userPositionsAccount: any =
    //         await clearingHouse.program.account.userPositions.fetch(user.positions);
    //
    //     assert.ok(
    //         userPositionsAccount.positions[0].baseAssetAmount
    //             .abs()
    //             .lt(userPositionsAccount0.positions[0].baseAssetAmount.abs())
    //     );
    //     assert.ok(
    //         userPositionsAccount.positions[0].quoteAssetAmount
    //             .abs()
    //             .lt(userPositionsAccount0.positions[0].quoteAssetAmount.abs())
    //     );
    //     assert.ok(user.collateral.lt(user0.collateral));
    //
    //     const chInsuranceAccountToken = await getTokenAccount(
    //         provider,
    //         state.insuranceVault
    //     );
    //     console.log(chInsuranceAccountToken.amount.toNumber());
    //
    //     assert.ok(chInsuranceAccountToken.amount.eq(new BN(38286)));
    //
    //     const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
    //
    //     assert.ok(tradeHistoryAccount.head.toNumber() === 6);
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[5].user.equals(userAccountPublicKey)
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[5].recordId.eq(new BN(6)));
    //     assert.ok(
    //         JSON.stringify(tradeHistoryAccount.tradeRecords[5].direction) ===
    //         JSON.stringify(PositionDirection.LONG)
    //     );
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[5].baseAssetAmount.eq(
    //             new BN(122540290722645)
    //         )
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[5].liquidation);
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[5].quoteAssetAmount.eq(new BN(13936590))
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[5].marketIndex.eq(new BN(0)));
    //
    //     const liquidationHistory = clearingHouse.getLiquidationHistoryAccount();
    //     assert.ok(liquidationHistory.head.toNumber() === 1);
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].user.equals(userAccountPublicKey)
    //     );
    //     assert.ok(liquidationHistory.liquidationRecords[0].recordId.eq(new BN(1)));
    //     assert.ok(liquidationHistory.liquidationRecords[0].partial);
    //
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].baseAssetValue.eq(
    //             new BN(55746362)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].baseAssetValueClosed.eq(
    //             new BN(13936590)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].liquidationFee.eq(new BN(76571))
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].feeToLiquidator.eq(new BN(38285))
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].feeToInsuranceFund.eq(
    //             new BN(38286)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].liquidator.equals(
    //             userAccountPublicKey
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].totalCollateral.eq(
    //             new BN(3062850)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].collateral.eq(new BN(9801741))
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].unrealizedPnl.eq(
    //             new BN(-6738891)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[0].marginRatio.eq(new BN(549))
    //     );
    // });
    //
    // it('Full Liquidation', async () => {
    //     const marketIndex = new BN(0);
    //
    //     const user0: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     const userPositionsAccount0: any =
    //         await clearingHouse.program.account.userPositions.fetch(user0.positions);
    //
    //     const liqPrice = userAccount.liquidationPrice(
    //         userPositionsAccount0.positions[0],
    //         new BN(0),
    //         false
    //     );
    //
    //     const marketsAccount: any = clearingHouse.getMarketsAccount();
    //     const marketData = marketsAccount.markets[0];
    //     await setFeedPrice(
    //         anchor.workspace.Pyth,
    //         convertToNumber(liqPrice),
    //         marketData.amm.oracle
    //     );
    //
    //     await clearingHouse.moveAmmToPrice(marketIndex, liqPrice);
    //
    //     // having the user liquidate themsevles because I'm too lazy to create a separate liquidator account
    //     await clearingHouse.liquidate(userAccountPublicKey);
    //     const state: any = clearingHouse.getStateAccount();
    //     const user: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     const userPositionsAccount: any =
    //         await clearingHouse.program.account.userPositions.fetch(user.positions);
    //     console.log(
    //         convertToNumber(
    //             userPositionsAccount.positions[0].baseAssetAmount,
    //             AMM_RESERVE_PRECISION
    //         )
    //     );
    //     assert.ok(userPositionsAccount.positions[0].baseAssetAmount.eq(new BN(0)));
    //     assert.ok(userPositionsAccount.positions[0].quoteAssetAmount.eq(new BN(0)));
    //     assert.ok(user.collateral.eq(new BN(0)));
    //     assert.ok(
    //         userPositionsAccount.positions[0].lastCumulativeFundingRate.eq(new BN(0))
    //     );
    //
    //     const chInsuranceAccountToken = await getTokenAccount(
    //         provider,
    //         state.insuranceVault
    //     );
    //     console.log(chInsuranceAccountToken.amount.toNumber());
    //
    //     assert.ok(chInsuranceAccountToken.amount.eq(new BN(2025225)));
    //
    //     const tradeHistoryAccount = clearingHouse.getTradeHistoryAccount();
    //
    //     assert.ok(tradeHistoryAccount.head.toNumber() === 7);
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[6].user.equals(userAccountPublicKey)
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[6].recordId.eq(new BN(7)));
    //     assert.ok(
    //         JSON.stringify(tradeHistoryAccount.tradeRecords[6].direction) ===
    //         JSON.stringify(PositionDirection.LONG)
    //     );
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[6].baseAssetAmount.eq(
    //             new BN(367582458630206)
    //         )
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[6].liquidation);
    //     assert.ok(
    //         tradeHistoryAccount.tradeRecords[6].quoteAssetAmount.eq(new BN(42704537))
    //     );
    //     assert.ok(tradeHistoryAccount.tradeRecords[6].marketIndex.eq(new BN(0)));
    //
    //     const liquidationHistory = clearingHouse.getLiquidationHistoryAccount();
    //     assert.ok(liquidationHistory.head.toNumber() === 2);
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].user.equals(userAccountPublicKey)
    //     );
    //     assert.ok(liquidationHistory.liquidationRecords[1].recordId.eq(new BN(2)));
    //     assert.ok(!liquidationHistory.liquidationRecords[1].partial);
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].baseAssetValue.eq(
    //             new BN(42704537)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].baseAssetValueClosed.eq(
    //             new BN(42704537)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].liquidationFee.eq(
    //             new BN(2091514)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].feeToLiquidator.eq(
    //             new BN(104575)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].feeToInsuranceFund.eq(
    //             new BN(1986939)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].liquidator.equals(
    //             userAccountPublicKey
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].totalCollateral.eq(
    //             new BN(2091514)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].collateral.eq(new BN(8041407))
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].unrealizedPnl.eq(
    //             new BN(-5949893)
    //         )
    //     );
    //     assert.ok(
    //         liquidationHistory.liquidationRecords[1].marginRatio.eq(new BN(489))
    //     );
    // });
    //
    // it('Pay from insurance fund', async () => {
    //     const state: any = clearingHouse.getStateAccount();
    //     const marketsAccount: any = clearingHouse.getMarketsAccount();
    //     const marketData = marketsAccount.markets[0];
    //
    //     mintToInsuranceFund(state.insuranceVault, usdcMint, usdcAmount, provider);
    //     let userUSDCTokenAccount = await getTokenAccount(
    //         provider,
    //         userUSDCAccount.publicKey
    //     );
    //     console.log(userUSDCTokenAccount.amount);
    //     await mintToInsuranceFund(userUSDCAccount, usdcMint, usdcAmount, provider);
    //
    //     userUSDCTokenAccount = await getTokenAccount(
    //         provider,
    //         userUSDCAccount.publicKey
    //     );
    //
    //     console.log(userUSDCTokenAccount.amount);
    //
    //     const initialUserUSDCAmount = userUSDCTokenAccount.amount;
    //
    //     await clearingHouse.depositCollateral(
    //         initialUserUSDCAmount,
    //         userUSDCAccount.publicKey
    //     );
    //
    //     await setFeedPrice(anchor.workspace.Pyth, 1.11, marketData.amm.oracle);
    //     const newUSDCNotionalAmount = calculateTradeAmount(initialUserUSDCAmount);
    //     await clearingHouse.openPosition(
    //         PositionDirection.LONG,
    //         newUSDCNotionalAmount,
    //         new BN(0)
    //     );
    //
    //     await setFeedPrice(anchor.workspace.Pyth, 1000, marketData.amm.oracle);
    //     // Send the price to the moon so that user has huge pnl
    //     await clearingHouse.moveAmmPrice(
    //         ammInitialBaseAssetAmount.div(new BN(1000)),
    //         ammInitialQuoteAssetAmount,
    //         new BN(0)
    //     );
    //
    //     await clearingHouse.closePosition(new BN(0));
    //
    //     const user: any = await clearingHouse.program.account.user.fetch(
    //         userAccountPublicKey
    //     );
    //     assert(user.collateral.gt(initialUserUSDCAmount));
    //
    //     await clearingHouse.withdrawCollateral(
    //         user.collateral,
    //         userUSDCAccount.publicKey
    //     );
    //
    //     // To check that we paid from insurance fund, we check that user usdc is greater than start of test
    //     // and insurance and collateral funds have 0 balance
    //     userUSDCTokenAccount = await getTokenAccount(
    //         provider,
    //         userUSDCAccount.publicKey
    //     );
    //     assert(userUSDCTokenAccount.amount.gt(initialUserUSDCAmount));
    //
    //     const chCollateralAccountToken = await getTokenAccount(
    //         provider,
    //         state.collateralVault
    //     );
    //     assert(chCollateralAccountToken.amount.eq(new BN(0)));
    //
    //     const chInsuranceAccountToken = await getTokenAccount(
    //         provider,
    //         state.insuranceVault
    //     );
    //     assert(chInsuranceAccountToken.amount.eq(new BN(0)));
    //
    //     await setFeedPrice(anchor.workspace.Pyth, 1, marketData.amm.oracle);
    //     await clearingHouse.moveAmmPrice(
    //         ammInitialBaseAssetAmount,
    //         ammInitialQuoteAssetAmount,
    //         new BN(0)
    //     );
    // });
    //
    // it('Trade small size position', async () => {
    //     await clearingHouse.openPosition(
    //         PositionDirection.LONG,
    //         new BN(10000),
    //         new BN(0)
    //     );
    // });
    //
    // it('Short order succeeds due to realiziable limit price ', async () => {
    //     const newUSDCNotionalAmount = usdcAmount.div(new BN(2)).mul(new BN(5));
    //     const marketIndex = new BN(0);
    //     const market = clearingHouse.getMarket(marketIndex);
    //     const estTradePrice = calculateTradeSlippage(
    //         PositionDirection.SHORT,
    //         newUSDCNotionalAmount,
    //         market
    //     )[2];
    //
    //     await clearingHouse.openPosition(
    //         PositionDirection.SHORT,
    //         newUSDCNotionalAmount,
    //         marketIndex,
    //         estTradePrice
    //     );
    //
    //     await clearingHouse.closePosition(marketIndex);
    // });
    //
    // it('Long order succeeds due to realiziable limit price ', async () => {
    //     const newUSDCNotionalAmount = usdcAmount.div(new BN(2)).mul(new BN(5));
    //     const marketIndex = new BN(0);
    //     const market = clearingHouse.getMarket(marketIndex);
    //     const estTradePrice = calculateTradeSlippage(
    //         PositionDirection.LONG,
    //         newUSDCNotionalAmount,
    //         market
    //     )[2];
    //
    //     await clearingHouse.openPosition(
    //         PositionDirection.LONG,
    //         newUSDCNotionalAmount,
    //         marketIndex,
    //         estTradePrice
    //     );
    //
    //     await clearingHouse.closePosition(marketIndex);
    // });
});
