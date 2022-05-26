import { BN } from '@project-serum/anchor';
import { assert } from '../assert/assert';
import { ZERO } from './../constants/numericConstants';

export class BigNum {
	val: BN;
	precision: BN;

	static delim = '.';

	constructor(val: BN | number, precisionVal: BN | number = new BN(0)) {
		const bn = typeof val === 'number' ? new BN(val) : val;
		const precision =
			typeof precisionVal === 'number' ? new BN(precisionVal) : precisionVal;

		this.val = new BN(bn);
		this.precision = new BN(precision);
	}

	public add(bn: BigNum): BigNum {
		assert(bn.precision.eq(this.precision), 'Adding unequal precisions');

		return BigNum.from(this.val.add(bn.val), this.precision);
	}

	public sub(bn: BigNum): BigNum {
		assert(bn.precision.eq(this.precision), 'Subtracting unequal precisions');

		return BigNum.from(this.val.sub(bn.val), this.precision);
	}

	public mul(bn: BigNum | BN): BigNum {
		if (bn instanceof BN) return BigNum.from(this.val.mul(bn), this.precision);

		return BigNum.from(this.val.mul(bn.val), this.precision.add(bn.precision));
	}

	/**
	 * Multiplies by another big number then scales the result down by the big number's precision so that we're in the same precision space
	 * @param bn
	 * @returns
	 */
	public scalarMul(bn: BigNum): BigNum {
		if (bn instanceof BN) return BigNum.from(this.val.mul(bn), this.precision);

		return BigNum.from(
			this.val.mul(bn.val),
			this.precision.add(bn.precision)
		).shift(bn.precision.neg());
	}

	public div(bn: BigNum | BN): BigNum {
		if (bn instanceof BN) return BigNum.from(this.val.div(bn), this.precision);
		return BigNum.from(this.val.div(bn.val), this.precision.sub(bn.precision));
	}

	/**
	 * Shift precision up or down
	 * @param bn
	 * @param skipAdjustingPrecision
	 * @returns
	 */
	public shift(bn: BN, skipAdjustingPrecision = false): BigNum {
		return BigNum.from(
			bn.isNeg()
				? this.val.div(new BN(10).pow(bn))
				: this.val.mul(new BN(10).pow(bn)),
			skipAdjustingPrecision ? this.precision : this.precision.add(bn)
		);
	}

	/**
	 * Shift to a target precision
	 * @param targetPrecision
	 * @returns
	 */
	public shiftTo(targetPrecision: BN): BigNum {
		return this.shift(targetPrecision.sub(this.precision));
	}

	/**
	 * Scale the number by a fraction
	 * @param numerator
	 * @param denominator
	 * @returns
	 */
	public scale(numerator: BN | number, denominator: BN | number): BigNum {
		return this.mul(new BN(numerator)).div(new BN(denominator));
	}

	public gt(bn: BigNum | BN): boolean {
		const comparisonVal = bn instanceof BigNum ? bn.val : bn;

		return this.val.gt(comparisonVal);
	}

	public lt(bn: BigNum | BN): boolean {
		const comparisonVal = bn instanceof BigNum ? bn.val : bn;

		return this.val.lt(comparisonVal);
	}

	public gte(bn: BigNum | BN): boolean {
		const comparisonVal = bn instanceof BigNum ? bn.val : bn;

		return this.val.gte(comparisonVal);
	}

	public lte(bn: BigNum | BN): boolean {
		const comparisonVal = bn instanceof BigNum ? bn.val : bn;

		return this.val.lte(comparisonVal);
	}

	public eq(bn: BigNum | BN): boolean {
		const comparisonVal = bn instanceof BigNum ? bn.val : bn;

		return this.val.eq(comparisonVal);
	}

	public eqZero() {
		return this.val.eq(ZERO);
	}

	public abs(): BigNum {
		return new BigNum(this.val.abs(), this.precision);
	}

	public toString = (base?: number | 'hex', length?: number): string =>
		this.val.toString(base, length);

	/**
	 * Pretty print the underlying value in human-readable form. Depends on precision being correct for the output string to be correct
	 * @returns
	 */
	public print(): string {
		assert(
			this.precision.gte(ZERO),
			'Tried to print a BN with precision lower than zero'
		);

		const plainString = this.toString();
		const precisionNum = this.precision.toNumber();

		// make a string with at least the precisionNum number of zeroes
		let printString = [
			...Array(this.precision.toNumber()).fill(0),
			...plainString.split(''),
		].join('');

		// inject decimal
		printString =
			printString.substring(0, printString.length - precisionNum) +
			BigNum.delim +
			printString.substring(printString.length - precisionNum);

		// remove leading zeroes
		printString = printString.replace(/^0+/, '');

		// add zero if leading delim
		if (printString[0] === BigNum.delim) printString = `0${printString}`;

		// remove trailing delim
		if (printString[printString.length - 1] === BigNum.delim)
			printString = printString.slice(0, printString.length - 1);

		return printString;
	}

	public debug() {
		console.log(
			`${this.toString()} | ${this.print()} | ${this.precision.toString()}`
		);
	}

	/**
	 * Pretty print with the specified number of decimal places
	 * @param fixedPrecision
	 * @returns
	 */
	public toFixed(fixedPrecision: number): string {
		const printString = this.print();

		const [leftSide, rightSide] = printString.split(BigNum.delim);

		const filledRightSide = [
			...rightSide.slice(0, fixedPrecision),
			...Array(fixedPrecision).fill('0'),
		]
			.slice(0, fixedPrecision)
			.join('');

		return `${leftSide}${BigNum.delim}${filledRightSide}`;
	}

	/**
	 * Pretty print to the specified number of significant figures
	 * @param fixedPrecision
	 * @returns
	 */
	public toPrecision(fixedPrecision: number, trailingZeroes = false): string {
		const printString = this.print();

		let precisionPrintString = printString.slice(0, fixedPrecision + 1);

		if (
			!precisionPrintString.includes(BigNum.delim) ||
			precisionPrintString[precisionPrintString.length - 1] === BigNum.delim
		) {
			precisionPrintString = printString.slice(0, fixedPrecision);
		}

		const pointsOfPrecision = precisionPrintString.replace(
			BigNum.delim,
			''
		).length;

		if (pointsOfPrecision < fixedPrecision) {
			precisionPrintString = [
				...precisionPrintString.split(''),
				...Array(fixedPrecision - pointsOfPrecision).fill('0'),
			].join('');
		}

		if (!precisionPrintString.includes(BigNum.delim)) {
			const delimFullStringLocation = printString.indexOf(BigNum.delim);

			let skipExponent = false;

			if (delimFullStringLocation === -1) {
				// no decimal, not missing any precision
				skipExponent = true;
			}

			if (
				precisionPrintString[precisionPrintString.length - 1] === BigNum.delim
			) {
				// decimal is at end of string, not missing any precision, do nothing
				skipExponent = true;
			}

			if (printString.indexOf(BigNum.delim) === fixedPrecision) {
				// decimal is at end of string, not missing any precision, do nothing
				skipExponent = true;
			}

			if (!skipExponent) {
				const exponent = delimFullStringLocation - fixedPrecision;
				if (trailingZeroes) {
					precisionPrintString = `${precisionPrintString}${Array(exponent)
						.fill('0')
						.join('')}`;
				} else {
					precisionPrintString = `${precisionPrintString}e${exponent}`;
				}
			}
		}

		return precisionPrintString;
	}

	public toTradePrecision(): string {
		return this.toPrecision(6, true);
	}

	public toNotional(): string {
		const num = Number(this.print());

		return `${num < 0 ? `-` : ``}$${(
			Math.round(Math.abs(num) * 100) / 100
		).toLocaleString(undefined, {
			maximumFractionDigits: 2,
			minimumFractionDigits: 2,
		})}`;
	}

	public toMillified(precision = 3) {
		const stringVal = this.print();

		const [leftSide] = stringVal.split(BigNum.delim);

		if (!leftSide) {
			return this.shift(new BN(precision)).toPrecision(precision, true);
		}

		if (leftSide.length <= 3) {
			return this.shift(new BN(precision)).toPrecision(precision, true);
		}

		const unitTicks = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
		const unitNumber = Math.floor((leftSide.length - 1) / 3);
		const unit = unitTicks[unitNumber];

		let leadDigits = leftSide.slice(0, precision);

		if (leadDigits.length < precision) {
			leadDigits = [
				...leadDigits.split(''),
				...Array(precision - leadDigits.length).fill('0'),
			].join('');
		}

		// need to figure out which location to put the decimal
		//// how many digits are there after the decimal?

		const decimalLocation = leftSide.length - 3 * unitNumber;

		let leadString = '';

		if (decimalLocation >= precision) {
			leadString = `${leadDigits}`;
		} else {
			leadString = `${leadDigits.slice(0, decimalLocation)}${
				BigNum.delim
			}${leadDigits.slice(decimalLocation)}`;
		}

		return `${leadString}${unit}`;

		return decimalLocation;

		return `${leadDigits} : ${unit} : ${decimalLocation}`;

		// return `${currentNumString} ${currentNumString.length} ${unitTick} ${unitTicks[unitTick]}`;

		// if (precision > 3) {
		// 	unitTick += Math.floor(precision / 3);
		// }

		// const characters = currentNumString.slice(0, precision);

		// return `${characters} ${unitTicks[unitTick]}`;

		// const charactersAfterUnit = currentNumString.slice(
		// 	-precision,
		// 	0 - charactersBeforeUnit.length
		// );

		// const unit = unitTicks[unitTick];

		// return `${charactersBeforeUnit}${
		// 	charactersAfterUnit.length > 0
		// 		? `${BigNum.delim}${charactersAfterUnit}`
		// 		: ``
		// }${unit}`;
	}

	/**
	 * Create a BigNum instance
	 * @param val
	 * @param precision
	 * @returns
	 */
	static from(val: BN | number = ZERO, precision?: BN | number): BigNum {
		return new BigNum(val, precision);
	}

	/**
	 * Create a BigNum instance from a pretty-printed BigNum
	 * @param val
	 * @param precisionOverride
	 * @returns
	 */
	static fromPrint(val: string, precisionShift?: BN): BigNum {
		// Handle empty number edge cases
		if (!val) return BigNum.from(ZERO, precisionShift);
		if (!val.replace(BigNum.delim, ''))
			return BigNum.from(ZERO, precisionShift);

		const [leftSide, rightSide] = val.split(BigNum.delim);

		const rawBn = new BN(`${leftSide ?? ''}${rightSide ?? ''}`);

		const rightSideLength = rightSide?.length ?? 0;

		const totalShift = precisionShift
			? precisionShift.sub(new BN(rightSideLength))
			: ZERO;

		return BigNum.from(rawBn, precisionShift).shift(totalShift, true);
	}

	static max(a: BigNum, b: BigNum): BigNum {
		return a.gt(b) ? a : b;
	}

	static min(a: BigNum, b: BigNum): BigNum {
		return a.lt(b) ? a : b;
	}

	static zero(precision?: BN | number): BigNum {
		return BigNum.from(0, precision);
	}
}
