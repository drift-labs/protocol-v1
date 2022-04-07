import { BN } from '../';

export const squareRootBN = (n, closeness = new BN(1)): BN => {
	// Assuming the sqrt of n as n only
	let x = n;

	// The closed guess will be stored in the root
	let root;

	// To count the number of iterations
	let count = 0;
	const TWO = new BN(2);

	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	while (count < Number.MAX_SAFE_INTEGER) {
		count++;

		// Calculate more closed x
		root = x.add(n.div(x)).div(TWO);

		// Check for closeness
		if (x.sub(root).abs().lte(closeness)) break;

		// Update root
		x = root;
	}

	return root;

	// const scale = new BN(Math.sqrt(precision.toNumber()));
	// return root.mul(precision).div(scale);
};

// Javascript program to find cubic root of a number
// using Binary Search

// Returns the absolute value of n-mid*mid*mid
function diff(n, mid) {
	const midcubed = mid.mul(mid).mul(mid);
	if (n.gt(midcubed)) return n.sub(midcubed);
	else return midcubed.sub(n);
}

// Returns cube root of a no n
export const cubicRootBN = (n: BN, precision: BN): BN => {
	// Set start and end for binary search
	let start = new BN(0);
	let end = n;

	// Set precision
	const closeness = new BN(1);
	let count = 0;
	let mid;
	let error;
	while (count < Number.MAX_SAFE_INTEGER) {
		mid = start.add(end);
		mid = mid.div(new BN(2));
		// error = diff(n, mid);

		// If error is less than e then mid is
		// our answer so return mid
		// console.log(start, end, error);
		if (start.sub(end).abs().lte(closeness)) {
			return mid;
		}

		// If mid*mid*mid is greater than n set
		// end = mid
		const midcubed = mid.mul(mid).mul(mid).div(precision).div(precision);

		if (midcubed.gt(n)) {
			end = mid;
		} else {
			start = mid;
		}
		count += 1;
	}

	const scale = Math.cbrt(precision.toNumber());
	return mid.mul(precision).div(new BN(scale));
	// return mid.mul(new BN(scale));
};
