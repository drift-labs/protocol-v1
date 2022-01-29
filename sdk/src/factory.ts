import { ClearingHouse } from './clearingHouse';
import { ConfirmOptions, Connection, PublicKey } from '@solana/web3.js';
import { IWallet } from './types';
import { Idl, Program, Provider } from '@project-serum/anchor';
import clearingHouseIDL from './idl/clearing_house.json';
import { DefaultTxSender } from './tx/defaultTxSender';
import { PollingClearingHouseAccountSubscriber } from './accounts/pollingClearingHouseAccountSubscriber';

export function getClearingHouseThatPolls(
	connection: Connection,
	wallet: IWallet,
	clearingHouseProgramId: PublicKey,
	pollingFrequency: number,
	opts: ConfirmOptions = Provider.defaultOptions()
): ClearingHouse {
	const provider = new Provider(connection, wallet, opts);
	const program = new Program(
		clearingHouseIDL as Idl,
		clearingHouseProgramId,
		provider
	);
	const accountSubscriber = new PollingClearingHouseAccountSubscriber(
		program,
		pollingFrequency
	);
	const txSender = new DefaultTxSender(provider);
	return new ClearingHouse(
		connection,
		wallet,
		program,
		accountSubscriber,
		txSender,
		opts
	);
}
