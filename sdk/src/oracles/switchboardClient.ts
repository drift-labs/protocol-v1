import {
	loadSwitchboardProgram,
	SwitchboardDecimal,
} from '@switchboard-xyz/switchboard-v2';
import { Connection, PublicKey } from '@solana/web3.js';
import { DriftEnv } from '../config';
import { BN } from '@project-serum/anchor';
import { MARK_PRICE_PRECISION, TEN } from '../constants/numericConstants';
import { OracleClient, OraclePriceData } from './types';

type Program = ReturnType<typeof loadSwitchboardProgram>;

export class SwitchboardClient implements OracleClient {
	connection: Connection;
	env: DriftEnv;

	public constructor(connection: Connection, env: DriftEnv) {
		this.connection = connection;
		this.env = env;
	}

	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const accountInfo = await this.connection.getAccountInfo(pricePublicKey);
		return this.getOraclePriceDataFromBuffer(accountInfo.data);
	}

	public async getOraclePriceDataFromBuffer(
		buffer: Buffer
	): Promise<OraclePriceData> {
		const program = await this.getProgram();

		const aggregatorAccountData =
			program.account.aggregatorAccountData.coder.accounts.decode(
				'AggregatorAccountData',
				buffer
			);
		const price = convertSwitchboardDecimal(
			aggregatorAccountData.latestConfirmedRound.result as SwitchboardDecimal
		);

		const confidence = convertSwitchboardDecimal(
			aggregatorAccountData.latestConfirmedRound
				.stdDeviation as SwitchboardDecimal
		);

		const slot: BN = aggregatorAccountData.latestConfirmedRound.roundOpenSlot;
		return {
			price,
			slot,
			confidence,
		};
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
