import { addressWord, decodeReserveTokens, encodeAddress } from './abi';
import { AAVE_DATA_PROVIDER_SELECTORS, PROTOCOL_REGISTRY } from './protocolRegistry';

export interface RegistryEventContract {
  protocolId: string;
  reserveKey: string;
  role?: 'protocol_token' | 'debt_token' | 'reward' | 'reward_controller' | 'reward_source';
}

export type EventRegistryRpc = (method: string, params: unknown[]) => Promise<unknown>;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const canonicalAddress = (value: string): boolean => /^0x[0-9a-f]{40}$/.test(value) && value !== ZERO_ADDRESS;

async function ethCall(rpc: EventRegistryRpc, to: string, data: string, block: string): Promise<string> {
  const result = await rpc('eth_call', [{ to, data }, block]);
  if (typeof result !== 'string' || !/^0x[0-9a-f]*$/i.test(result)) throw new Error('Malformed event-registry eth_call result.');
  return result;
}

/**
 * Reads the exhaustive reserve/token registry without consulting wallet
 * balances. Fully withdrawn/repaid reserves therefore remain decodable.
 */
export async function fetchDefiEventContractRegistry(
  rpc: EventRegistryRpc,
  requestedBlock?: string
): Promise<{ block: string; contracts: Readonly<Record<string, RegistryEventContract>> }> {
  const block = requestedBlock ?? await rpc('eth_blockNumber', []);
  if (typeof block !== 'string' || !/^0x[0-9a-f]+$/i.test(block)) throw new Error('Malformed event-registry block number.');
  const contracts: Record<string, RegistryEventContract> = {};
  const register = (address: string, mapping: RegistryEventContract): void => {
    if (!canonicalAddress(address)) throw new Error('Event registry returned a zero or non-canonical token address.');
    if (contracts[address]) throw new Error('Event registry returned a duplicate or conflicting contract mapping.');
    contracts[address] = mapping;
  };
  for (const entry of Object.values(PROTOCOL_REGISTRY)) {
    const reserves = decodeReserveTokens(await ethCall(
      rpc, entry.dataProviderAddress, AAVE_DATA_PROVIDER_SELECTORS.getAllReservesTokens, block
    ));
    if (reserves.length === 0) throw new Error(`Event registry returned no reserves for ${entry.id}.`);
    const seenReserves = new Set<string>();
    for (const reserve of reserves) {
      const reserveKey = reserve.address.toLowerCase();
      if (!canonicalAddress(reserveKey) || seenReserves.has(reserveKey)) throw new Error('Event registry returned an invalid or duplicate reserve.');
      seenReserves.add(reserveKey);
      const tokenData = await ethCall(
        rpc, entry.dataProviderAddress,
        `${AAVE_DATA_PROVIDER_SELECTORS.getReserveTokensAddresses}${encodeAddress(reserveKey)}`,
        block
      );
      const aToken = addressWord(tokenData, 0);
      const stableDebtToken = addressWord(tokenData, 1);
      const variableDebtToken = addressWord(tokenData, 2);
      if (new Set([aToken, stableDebtToken, variableDebtToken]).size !== 3) throw new Error('Event registry returned an incomplete or duplicate reserve-token triple.');
      register(aToken, { protocolId: entry.id, reserveKey, role: 'protocol_token' });
      register(stableDebtToken, { protocolId: entry.id, reserveKey, role: 'debt_token' });
      register(variableDebtToken, { protocolId: entry.id, reserveKey, role: 'debt_token' });
    }
    for (const controller of entry.rewardControllerAddresses) {
      register(controller.toLowerCase(), { protocolId: entry.id, reserveKey: 'unknown', role: 'reward_controller' });
    }
    for (const source of entry.rewardSourceAddresses) {
      register(source.toLowerCase(), { protocolId: entry.id, reserveKey: 'unknown', role: 'reward_source' });
    }
    for (const rewardToken of entry.rewardTokenAddresses) {
      const address = rewardToken.toLowerCase();
      register(address, { protocolId: entry.id, reserveKey: address, role: 'reward' });
    }
  }
  return { block, contracts: Object.freeze(contracts) };
}
