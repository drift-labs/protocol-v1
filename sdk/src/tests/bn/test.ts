import { BN } from '@project-serum/anchor';
import { expect } from 'chai';
import { BigNum } from '../../factory/bigNum';
import {
	TEN_THOUSAND,
	AMM_RESERVE_PRECISION_EXP,
	BASE_PRECISION_EXP,
} from './../../constants/numericConstants';
// if you used the '@types/mocha' method to install mocha type definitions, uncomment the following line
// import 'mocha';

describe('BigNum Tests', () => {
	it('basic string representations are correct', () => {
		const bn = BigNum.from(TEN_THOUSAND);
		expect(bn.toString()).to.equal('10000');
		expect(bn.print()).to.equal('10000');

		const bn2 = BigNum.from(TEN_THOUSAND, new BN(4));
		expect(bn2.toString()).to.equal('10000');
		expect(bn2.print()).to.equal('1.0000');

		const bn3 = BigNum.from(new BN('123456789'), new BN(4));
		expect(bn3.toString()).to.equal('123456789');
		expect(bn3.print()).to.equal('12345.6789');
	});

	it('can do basic maths correctly', () => {
		const val1 = BigNum.from(10 ** 4, 2).mul(BigNum.from(123456));

		expect(val1.toString()).to.equal('1234560000');

		// should trim one point of precision off
		const val2 = val1.div(BigNum.from(10 ** 5));

		expect(val2.toString()).to.equal('12345');
		expect(val2.print()).to.equal('123.45');

		// Trying to represent a 33.33333333% figure to precision 4
		const baseNumberPrecision = 10;
		const adjustmentPrecision = 4;

		const currentNumber = 400 * 10 ** baseNumberPrecision;
		const comparisonNumber = 300 * 10 ** baseNumberPrecision;

		const val3 = BigNum.from(currentNumber, baseNumberPrecision)
			.sub(BigNum.from(comparisonNumber, baseNumberPrecision))
			.mul(BigNum.from(10 ** adjustmentPrecision, adjustmentPrecision))
			.mul(BigNum.from(100))
			.div(BigNum.from(comparisonNumber, baseNumberPrecision))
			.abs();

		expect(val3.toString()).to.equal('333333');
		expect(val3.print()).to.equal('33.3333');
	});

	it('can shift numbers correctly', () => {
		const val1 = BigNum.from(new BN(`319657850313098510000000000`), 23).shift(
			new BN(-10)
		);

		expect(val1.toString()).to.equal(`31965785031309851`);
		expect(val1.print()).to.equal(`3196.5785031309851`);
	});

	it('can print numbers correctly', () => {
		// Case 1
		const val = BigNum.from(123456789, 5);

		expect(val.toString()).to.equal('123456789');

		expect(val.print()).to.equal('1234.56789');

		expect(val.toFixed(3)).to.equal('1234.567');

		expect(val.toPrecision(1)).to.equal('1e3');
		expect(val.toPrecision(3)).to.equal('123e1');
		expect(val.toPrecision(4)).to.equal('1234');
		expect(val.toPrecision(5)).to.equal('1234.5');
		expect(val.toPrecision(11)).to.equal('1234.5678900');

		// Case 2
		const val2 = BigNum.from(1, 5);

		expect(val2.toString()).to.equal('1');

		expect(val2.print()).to.equal('0.00001');

		// Case 3
		const val3 = BigNum.from(101003, 5);

		expect(val3.toString()).to.equal('101003');

		expect(val3.print()).to.equal('1.01003');
		expect(val3.toPrecision(7)).to.equal('1.010030');

		// Case 4
		const rawQuoteValue = 1;
		const entryPriceNum = 40;
		const val4 = BigNum.from(rawQuoteValue * 10 ** 8)
			.shift(AMM_RESERVE_PRECISION_EXP)
			.div(BigNum.from(entryPriceNum * 10 ** 8));

		expect(val4.toString()).to.equal('250000000000');
		expect(val4.print()).to.equal('0.0250000000000');
		expect(val4.toFixed(3)).to.equal('0.025');
		expect(val4.toPrecision(4)).to.equal('0.025');

		// Case 5
		expect(BigNum.fromPrint('1').toMillified()).to.equal('1.00');
		expect(BigNum.fromPrint('12').toMillified()).to.equal('12.0');
		expect(BigNum.fromPrint('123').toMillified()).to.equal('123');
		expect(BigNum.fromPrint('1234').toMillified()).to.equal('1.23K');
		expect(BigNum.fromPrint('12345').toMillified()).to.equal('12.3K');
		expect(BigNum.fromPrint('123456').toMillified()).to.equal('123K');
		expect(BigNum.fromPrint('1234567').toMillified()).to.equal('1.23M');
		expect(BigNum.fromPrint('12345678').toMillified()).to.equal('12.3M');
		expect(BigNum.fromPrint('123456789').toMillified()).to.equal('123M');

		expect(BigNum.fromPrint('1').toMillified(5)).to.equal('1.0000');
		expect(BigNum.fromPrint('12').toMillified(5)).to.equal('12.000');
		expect(BigNum.fromPrint('123').toMillified(5)).to.equal('123.00');
		expect(BigNum.fromPrint('1234').toMillified(5)).to.equal('1.2340K');
		expect(BigNum.fromPrint('12345').toMillified(5)).to.equal('12.345K');
		expect(BigNum.fromPrint('123456').toMillified(5)).to.equal('123.45K');
		expect(BigNum.fromPrint('1234567').toMillified(5)).to.equal('1.2345M');
		expect(BigNum.fromPrint('12345678').toMillified(5)).to.equal('12.345M');
		expect(BigNum.fromPrint('123456789').toMillified(5)).to.equal('123.45M');
	});

	it('can initialise from string values correctly', () => {
		// Case 1

		const baseAmountVal1 = '14.33';
		const val1 = BigNum.fromPrint(baseAmountVal1, BASE_PRECISION_EXP);

		expect(val1.toString()).to.equal('143300000000000');
		expect(val1.print()).to.equal('14.3300000000000');
	});

	it('is immutable', () => {
		// Case 1
		const initVal = BigNum.from(1);
		const postShift = initVal.shift(new BN(10), true);
		const postScale = postShift.scale(1, 10 ** 10);

		expect(initVal.toString()).to.equal(postScale.toString());
		expect(initVal === postShift).to.equal(false);
		expect(initVal.val === postShift.val).to.equal(false);
		expect(initVal === postScale).to.equal(false);
		expect(initVal.val === postScale.val).to.equal(false);
		expect(postShift === postScale).to.equal(false);
		expect(postShift.val === postScale.val).to.equal(false);

		const postMul = postScale.mul(new BN(1000));
		const postDiv = postMul.div(new BN(1000));

		expect(postMul.toString()).to.equal('1000');
		expect(postDiv.toString()).to.equal('1');
		expect(postMul === postDiv).to.equal(false);
		expect(postMul.val === postDiv.val).to.equal(false);

		const postAdd = postDiv.add(BigNum.from(new BN(1000)));
		const postSub = postAdd.sub(BigNum.from(new BN(1000)));

		expect(postAdd.toString()).to.equal('1001');
		expect(postSub.toString()).to.equal('1');
		expect(postAdd === postSub).to.equal(false);
		expect(postAdd.val === postSub.val).to.equal(false);
	});

	it('serializes properly', () => {
		// JSON
		let val = BigNum.from(new BN('123456'), 3);
		expect(val.toString()).to.equal('123456');
		val = val.shift(new BN(3));
		expect(val.toString()).to.equal('123456000');
		expect(val.print()).to.equal('123.456000');

		const stringified = JSON.stringify(val);

		expect(stringified).to.equal('{"val":"123456000","precision":"6"}');

		let parsed = BigNum.fromJSON(JSON.parse(stringified));
		expect(parsed.toString()).to.equal('123456000');
		expect(parsed.print()).to.equal('123.456000');

		parsed = parsed.shift(new BN(3));
		expect(parsed.toString()).to.equal('123456000000');
		expect(parsed.print()).to.equal('123.456000000');
	});
});
