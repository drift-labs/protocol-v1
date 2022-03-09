import {
	AggregatorAccount,
	SBV2_DEVNET_PID,
	SBV2_MAINNET_PID,
} from '@switchboard-xyz/switchboard-v2';
import { ConfirmOptions, Connection, PublicKey } from '@solana/web3.js';
import { Wallet } from './wallet';
import { Program, Provider } from '@project-serum/anchor-v0.22';
import { DriftEnv } from './config';

export class SwitchboardClient {
	private programId: PublicKey;
	private connection: Connection;
	private wallet: Wallet;
	private opts: ConfirmOptions;

	public constructor(
		programId: PublicKey,
		connection: Connection,
		wallet: Wallet,
		opts: ConfirmOptions = Provider.defaultOptions()
	) {
		this.programId = programId;
		this.connection = connection;
		this.wallet = wallet;
		this.opts = opts;
	}

	public async getPriceData(pricePublicKey: PublicKey): Promise<> {
		const aggregatorAccount: AggregatorAccount = new AggregatorAccount({
			program: await this.getProgram(),
			publicKey: pricePublicKey,
		});

		console.log(await aggregatorAccount.loadData());
	}

	private program: Program;
	public async getProgram(): Promise<Program> {
		if (this.program) {
			return this.program;
		}

		const provider = new Provider(this.connection, this.wallet, this.opts);
		const idl = await Program.fetchIdl(SBV2_MAINNET_PID, provider);

		if (!idl) {
			throw new Error(`failed to read idl for ${this.programId}`);
		}

		return new Program(idl, this.programId, provider);
	}
}

export function getSwitchboardProgramId(env: DriftEnv): PublicKey {
	return env === 'mainnet-beta' ? SBV2_MAINNET_PID : SBV2_DEVNET_PID;
}
