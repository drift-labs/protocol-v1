import {
	AggregatorAccount,
	loadSwitchboardProgram,
	SwitchboardDecimal,
} from '@switchboard-xyz/switchboard-v2';
import { Connection, PublicKey } from '@solana/web3.js';
import { DriftEnv } from './config';
import { BN } from '@project-serum/anchor';
import { MARK_PRICE_PRECISION, TEN } from './constants/numericConstants';

type Program = ReturnType<typeof loadSwitchboardProgram>;

export class SwitchboardClient {
	connection: Connection;
	env: DriftEnv;

	public constructor(connection: Connection, env: DriftEnv) {
		this.connection = connection;
		this.env = env;
	}

	public async getPrice(pricePublicKey: PublicKey): Promise<BN> {
		const aggregatorAccount: AggregatorAccount = new AggregatorAccount({
			program: await this.getProgram(),
			publicKey: pricePublicKey,
		});

		const aggregatorData = await aggregatorAccount.loadData();
		return convertSwitchboardDecimal(
			aggregatorData.latestConfirmedRound.result as SwitchboardDecimal
		);
	}

	private program: Program;
	public async getProgram(): Promise<Program> {
		if (this.program) {
			return this.program;
		}

		this.program = loadSwitchboardProgram(this.env, this.connection);
		return this.program;
	}
}

function convertSwitchboardDecimal(switchboardDecimal: SwitchboardDecimal): BN {
	const switchboardPrecision = TEN.pow(new BN(switchboardDecimal.scale));
	return switchboardDecimal.mantissa
		.mul(MARK_PRICE_PRECISION)
		.div(switchboardPrecision);
}
