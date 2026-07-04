import { makeId } from '@/lib/parsers/types';
import type { Transaction } from '@/types/transaction';
import type { LookupResult, LookupWarning } from '@/lib/rpc/providers';

/** Etherscan-compatible explorer — full history in one request (no pagination in API). */
export async function fetchEtherscanCompatible(
  address: string,
  baseUrl: string,
  apiKey: string,
  asset: string
): Promise<LookupResult> {
  const nativeUrl = `${baseUrl}?module=account&action=txlist&address=${address}&sort=desc${apiKey ? `&apikey=${apiKey}` : ''}`;
  const tokenUrl = `${baseUrl}?module=account&action=tokentx&address=${address}&sort=desc${apiKey ? `&apikey=${apiKey}` : ''}`;

  const [nativeRes, tokenRes] = await Promise.all([fetch(nativeUrl), fetch(tokenUrl)]);
  if (!nativeRes.ok) throw new Error(`Explorer API returned ${nativeRes.status}`);
  const nativeData = await nativeRes.json();
  const tokenData = tokenRes.ok ? await tokenRes.json() : { status: '0', result: [] };

  const warnings: LookupWarning[] = [];
  if (nativeData.status !== '1' || !Array.isArray(nativeData.result)) {
    warnings.push({ address, message: nativeData.message || 'No native transactions returned.' });
  }

  const toTx = (row: Record<string, string>, isToken: boolean): Transaction => {
    const decimals = isToken ? Number(row.tokenDecimal || '18') : 18;
    const valueRaw = BigInt(row.value || '0');
    const amount = Number(valueRaw) / 10 ** decimals;
    const isOutgoing = row.from?.toLowerCase() === address.toLowerCase();
    return {
      id: makeId('rpc'),
      timestamp: Number(row.timeStamp) * 1000,
      type: isOutgoing ? 'transfer_out' : 'transfer_in',
      asset: isToken ? row.tokenSymbol || 'TOKEN' : asset,
      amount,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:etherscan_compatible',
      sourceRef: row.hash,
      walletAddress: address,
      counterpartyAddress: isOutgoing ? row.to : row.from,
      contractAddress: isToken ? row.contractAddress : undefined,
      flags: ['possible_internal_transfer', 'missing_cost_basis'] as const,
      isInternalTransfer: false,
      raw: row
    } as Transaction;
  };

  const transactions: Transaction[] = [
    ...(Array.isArray(nativeData.result) ? nativeData.result.map((r: Record<string, string>) => toTx(r, false)) : []),
    ...(Array.isArray(tokenData.result) ? tokenData.result.map((r: Record<string, string>) => toTx(r, true)) : [])
  ];

  return { transactions, warnings };
}
