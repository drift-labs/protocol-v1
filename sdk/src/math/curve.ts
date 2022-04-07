import { BN } from '@project-serum/anchor';
import {
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	MARK_PRICE_PRECISION,
	PEG_PRECISION,
	ZERO,
	AMM_TO_QUOTE_PRECISION_RATIO,
	QUOTE_PRECISION,
	AMM_RESERVE_PRECISION,
} from '../constants/numericConstants';
import { calculateBaseAssetValue } from './position';
import {
	AMM,
	PositionDirection,
	SwapDirection,
	Market,
	isVariant,
} from '../types';
import { assert } from '../assert/assert';
import {
	calculatePositionPNL,
	calculateMarkPrice,
	convertToNumber,
	squareRootBN,
} from '..';
export type AssetType = 'quote' | 'base';

// CONSTANT PRODUCT
// x * y = k

/**
 * Helper function calculating constant product curve output. Agnostic to whether input asset is quote or base
 *
 * @param inputAssetReserve
 * @param swapAmount
 * @param swapDirection
 * @param invariant
 * @returns newInputAssetReserve and newOutputAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateSwapOutputCp(
	inputAssetReserve: BN,
	swapAmount: BN,
	swapDirection: SwapDirection,
	invariant: BN,
	inputAssetType: AssetType
): [BN, BN] {
	let newInputAssetReserve;
	if (swapDirection === SwapDirection.ADD) {
		newInputAssetReserve = inputAssetReserve.add(swapAmount);
	} else {
		newInputAssetReserve = inputAssetReserve.sub(swapAmount);
	}
	const newOutputAssetReserve = invariant.div(newInputAssetReserve);
	return [newInputAssetReserve, newOutputAssetReserve];
}

/**
 * Calculates a price given an arbitrary base and quote amount (they must have the same precision)
 *
 * @param baseAssetAmount
 * @param quoteAssetAmount
 * @param peg_multiplier
 * @returns price : Precision MARK_PRICE_PRECISION
 */
export function calculatePriceCp(
	baseAssetAmount: BN,
	quoteAssetAmount: BN,
	peg_multiplier: BN
): BN {
	if (baseAssetAmount.abs().lte(ZERO)) {
		return new BN(0);
	}

	return quoteAssetAmount
		.mul(MARK_PRICE_PRECISION)
		.mul(peg_multiplier)
		.div(PEG_PRECISION)
		.div(baseAssetAmount);
}

// CONSTANT POWER PRODUCT
// x * x * y = k
/**
 * Helper function calculating constant product curve output. Agnostic to whether input asset is quote or base
 *
 * @param inputAssetReserve
 * @param swapAmount
 * @param swapDirection
 * @param invariant
 * @returns newInputAssetReserve and newOutputAssetReserve after swap. : Precision AMM_RESERVE_PRECISION
 */
export function calculateSwapOutputCpSq(
	inputAssetReserve: BN,
	swapAmount: BN,
	swapDirection: SwapDirection,
	invariant: BN,
	inputAssetType: AssetType
): [BN, BN] {
	let newInputAssetReserve;
	if (swapDirection === SwapDirection.ADD) {
		newInputAssetReserve = inputAssetReserve.add(swapAmount);
	} else {
		newInputAssetReserve = inputAssetReserve.sub(swapAmount);
	}
	let newOutputAssetReserve;
	if (inputAssetType == 'base') {
		newOutputAssetReserve = invariant.div(
			newInputAssetReserve.mul(newInputAssetReserve).div(AMM_RESERVE_PRECISION)
		);
		console.log(
			convertToNumber(newInputAssetReserve, AMM_RESERVE_PRECISION),
			'^2 * ',
			convertToNumber(newOutputAssetReserve, AMM_RESERVE_PRECISION),
			'=',
			convertToNumber(
				invariant.div(AMM_RESERVE_PRECISION),
				AMM_RESERVE_PRECISION
			)
		);
	} else {
		newOutputAssetReserve = squareRootBN(invariant.div(newInputAssetReserve));
		console.log(
			convertToNumber(newOutputAssetReserve, AMM_RESERVE_PRECISION),
			'^2 * ',
			convertToNumber(newInputAssetReserve, AMM_RESERVE_PRECISION),
			'=',
			convertToNumber(
				invariant.div(AMM_RESERVE_PRECISION),
				AMM_RESERVE_PRECISION
			)
		);
	}

	return [newInputAssetReserve, newOutputAssetReserve];
}

/**
 * Calculates a price given an arbitrary base and quote amount (they must have the same precision)
 *
 * @param baseAssetAmount
 * @param quoteAssetAmount
 * @param peg_multiplier
 * @returns price : Precision MARK_PRICE_PRECISION
 */
export function calculatePriceCpSq(
	baseAssetAmount: BN,
	quoteAssetAmount: BN,
	peg_multiplier: BN
): BN {
	if (baseAssetAmount.abs().lte(ZERO)) {
		return new BN(0);
	}

	return (
		quoteAssetAmount
			.mul(MARK_PRICE_PRECISION)
			.mul(peg_multiplier)
			// .mul(new BN(2))
			.div(PEG_PRECISION)
			.div(baseAssetAmount)
	);
}
