import { alchemyFetch, alchemyRpcUrl } from '@/lib/rpc/providers';
import { AAVE_DATA_PROVIDER_SELECTORS, resolveProtocol } from './protocolRegistry';
import { addressWord, boolWord, decodeReserveTokens, decodeString, encodeAddress, quantity, uintWord } from './abi';
import type { DefiPositionResult, DefiPositionRow, ProtocolId, ProtocolTokenIdentity } from './types';

export type EthereumRpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export function createEthereumRpcCall(apiKey: string): EthereumRpcCall {
  const url = alchemyRpcUrl('eth-mainnet');
  let id = 0;
  return async (method, params) => {
    const response = await alchemyFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (!response.ok) throw new Error(`Ethereum RPC HTTP ${response.status}`);
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error || body.result == null) throw new Error(body.error?.message ?? 'Ethereum RPC result missing.');
    return body.result;
  };
}

async function ethCall(rpc: EthereumRpcCall, to: string, data: string, blockTag: string): Promise<string> {
  const result = await rpc('eth_call', [{ to, data }, blockTag]);
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) throw new Error('Malformed eth_call result.');
  return result;
}

async function tokenIdentity(rpc: EthereumRpcCall, token: string, fallbackSymbol: string, blockTag: string): Promise<ProtocolTokenIdentity> {
  const [decimalsData, symbolData] = await Promise.all([
    ethCall(rpc, token, AAVE_DATA_PROVIDER_SELECTORS.decimals, blockTag),
    ethCall(rpc, token, AAVE_DATA_PROVIDER_SELECTORS.symbol, blockTag).catch(() => '0x')
  ]);
  const decimals = Number(uintWord(decimalsData, 0));
  const symbol = symbolData === '0x' ? fallbackSymbol : decodeString(symbolData) || fallbackSymbol;
  return { chainId: 1, contractAddress: token.toLowerCase(), symbol, decimals };
}

/** Exhaustive Aave-compatible ProtocolDataProvider read; every call uses one block tag. */
export async function fetchAaveCompatibleRpcPositions(address: string, protocolId: ProtocolId, rpc: EthereumRpcCall, requestedBlockTag?: string): Promise<DefiPositionResult> {
  const entry = resolveProtocol(1, protocolId)!;
  try {
    const block = requestedBlockTag ?? await rpc('eth_blockNumber', []);
    if (typeof block !== 'string' || !/^0x[0-9a-fA-F]+$/.test(block)) throw new Error('Malformed block number.');
    const blockNumber = Number(BigInt(block));
    const reserves = decodeReserveTokens(await ethCall(rpc, entry.dataProviderAddress, AAVE_DATA_PROVIDER_SELECTORS.getAllReservesTokens, block));
    const rows: DefiPositionRow[] = [];
    for (const reserve of reserves) {
      const reserveArg = encodeAddress(reserve.address);
      const [userData, tokenData, underlying] = await Promise.all([
        ethCall(rpc, entry.dataProviderAddress, `${AAVE_DATA_PROVIDER_SELECTORS.getUserReserveData}${reserveArg}${encodeAddress(address)}`, block),
        ethCall(rpc, entry.dataProviderAddress, `${AAVE_DATA_PROVIDER_SELECTORS.getReserveTokensAddresses}${reserveArg}`, block),
        tokenIdentity(rpc, reserve.address, reserve.symbol, block)
      ]);
      const currentSupply = uintWord(userData, 0);
      const stableDebt = uintWord(userData, 1);
      const variableDebt = uintWord(userData, 2);
      const isCollateral = boolWord(userData, 8);
      const aToken = await tokenIdentity(rpc, addressWord(tokenData, 0), `a${underlying.symbol}`, block);
      const stableToken = await tokenIdentity(rpc, addressWord(tokenData, 1), `stableDebt${underlying.symbol}`, block);
      const variableToken = await tokenIdentity(rpc, addressWord(tokenData, 2), `variableDebt${underlying.symbol}`, block);
      const reserveKey = reserve.address.toLowerCase();
      if (currentSupply > 0n) rows.push({ id: `rpc:${protocolId}:${reserveKey}:supply`, snapshotId: '', protocolId, reserveKey, role: 'supply', underlying, protocolToken: aToken, quantity: quantity(currentSupply, underlying.decimals), rawQuantity: currentSupply.toString(), isCollateral });
      if (stableDebt > 0n) rows.push({ id: `rpc:${protocolId}:${reserveKey}:debt:stable`, snapshotId: '', protocolId, reserveKey, role: 'debt', underlying, protocolToken: stableToken, quantity: quantity(stableDebt, underlying.decimals), rawQuantity: stableDebt.toString(), debtRateMode: 'stable' });
      if (variableDebt > 0n) rows.push({ id: `rpc:${protocolId}:${reserveKey}:debt:variable`, snapshotId: '', protocolId, reserveKey, role: 'debt', underlying, protocolToken: variableToken, quantity: quantity(variableDebt, underlying.decimals), rawQuantity: variableDebt.toString(), debtRateMode: 'variable' });
    }
    return { status: 'complete', chainId: 1, protocolId, blockNumber, rows, evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber, detail: `All ${reserves.length} reserves and debt modes read at block ${blockNumber}.` }], warnings: [] };
  } catch (error) {
    return { status: 'partial', chainId: 1, protocolId, rows: [], evidence: [{ provider: 'ethereum-rpc', status: 'partial', detail: error instanceof Error ? error.message : 'RPC read failed.' }], warnings: ['Direct protocol verification was incomplete.'] };
  }
}
