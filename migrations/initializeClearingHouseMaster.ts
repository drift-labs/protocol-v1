import * as anchor from '@project-serum/anchor';
import { Program, Provider } from '@project-serum/anchor';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { ClearingHouse, PythClient } from '../sdk/';
import { AMM_MANTISSA, PEG_SCALAR } from '../sdk/src';

import dotenv = require('dotenv');
dotenv.config();
async function deployDevnet(provider: Provider) {
    const connection = provider.connection;
    const chProgram = anchor.workspace.ClearingHouse as Program;
    const clearingHouse = new ClearingHouse(
        connection,
        provider.wallet,
        chProgram.programId
    );

    console.log('Deploying wallet:', provider.wallet.publicKey.toString());
    console.log('ClearingHouse ProgramID:', chProgram.programId.toString());

    const usdcMint = new PublicKey("8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2");

    console.log('USDC Mint:', usdcMint.toString()); // TODO: put into Next config
    console.log('Initializing ClearingHouse');
    await clearingHouse.initialize(usdcMint, false);
    console.log('Initialized ClearingHouse');
    await clearingHouse.subscribe();

    const pythClient = new PythClient(clearingHouse.connection);

    function normAssetAmount(assetAmount: BN, pegMultiplier: BN): BN {
        // assetAmount is scaled to offer comparable slippage
        return assetAmount.mul(AMM_MANTISSA).div(pegMultiplier);
    }
    const devnetOracles = {
        SOL: 'J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix',
        // BTC: 'HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J',
        // ETH: 'EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw',
        // COPE: 'BAXDJUXtz6P5ARhHH1aPwgv4WENzHwzyhmLYK4daFwiM',
    };
    // const mainnetOracles = {
        // SOL: 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG',
        // BTC: 'GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU',
        // ETH: 'JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB',
        // COPE: '9xYBiDWYsh2fHzpsz3aaCnNHCKWBNtfEDLtU6kS4aFD9',
    // };
    const marketOracleKeys = Object.keys(devnetOracles);

    for (let i = 0; i < marketOracleKeys.length; i++) {
        const keyName = marketOracleKeys[i];
        const oraclePriceKey = devnetOracles[keyName];
        const oraclePriceData = await pythClient.getPriceData(
            new PublicKey(oraclePriceKey)
        );
        const astPrice =
            (oraclePriceData.price +
                oraclePriceData.previousPrice +
                oraclePriceData.twap.value) /
            3;
        console.log(keyName + ' Recent Average Price:', astPrice);

        const marketIndex = new BN(i);
        const periodicity = new BN(3600);
        const kSqrt = new anchor.BN(2 * 10 ** 12);
        const ammQuoteAssetAmount =  kSqrt;
        const ammBaseAssetAmount =  kSqrt;
        const pegMultiplierAst = new anchor.BN(astPrice * PEG_SCALAR.toNumber());

        console.log('Initializing Market for ', keyName, '/USD: ');
        await clearingHouse.initializeMarket(
            marketIndex,
            oraclePriceKey,
            normAssetAmount(ammBaseAssetAmount, pegMultiplierAst),
            normAssetAmount(ammQuoteAssetAmount, pegMultiplierAst),
            periodicity,
            pegMultiplierAst
        );
        console.log(keyName, `Market Index: ${marketIndex.toString()}`);
    }

    console.log("Updating whitelist mint");
    const whitelistMint = new PublicKey("k85XcekAVVs5YFc4SQh18kboSGHRum7hoNe6Fh281oY");
    console.log("whitelist mint", whitelistMint.toString());
    await clearingHouse.updateWhitelistMint(whitelistMint);
    console.log("Updated whitelist mint");

    await clearingHouse.unsubscribe();
}

try {
    if (!process.env.ANCHOR_WALLET) {
        throw new Error('ANCHOR_WALLET must be set.');
    }
    deployDevnet(
        anchor.Provider.local('https://psytrbhymqlkfrhudd.dev.genesysgo.net:8899/')
    );
} catch (e) {
    console.error(e);
}