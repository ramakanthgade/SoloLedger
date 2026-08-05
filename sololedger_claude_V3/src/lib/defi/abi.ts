function strip0x(value: string): string { return value.startsWith('0x') ? value.slice(2) : value; }
export function encodeAddress(value: string): string {
  const address = strip0x(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(address)) throw new Error('Invalid ABI address.');
  return address.padStart(64, '0');
}
export function word(data: string, index: number): string {
  const hex = strip0x(data);
  const value = hex.slice(index * 64, (index + 1) * 64);
  if (value.length !== 64) throw new Error('Truncated ABI response.');
  return value;
}
export function uintWord(data: string, index: number): bigint { return BigInt(`0x${word(data, index)}`); }
export function addressWord(data: string, index: number): string {
  const value = word(data, index);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(value)) throw new Error('Malformed ABI address word.');
  return `0x${value.slice(24).toLowerCase()}`;
}
export function boolWord(data: string, index: number): boolean {
  const value = uintWord(data, index);
  if (value !== 0n && value !== 1n) throw new Error('Malformed ABI bool word.');
  return value === 1n;
}
export function quantity(raw: bigint, decimals: number): number {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid token decimals.');
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  const result = Number(whole) + Number(fraction) / 10 ** decimals;
  if (!Number.isFinite(result)) throw new Error('Position quantity exceeds numeric range.');
  return result;
}
export function decodeString(data: string): string {
  const hex = strip0x(data);
  if (hex.length === 64) return new TextDecoder().decode(Uint8Array.from(hex.match(/../g)!.map((v) => Number.parseInt(v, 16)))).replace(/\0+$/, '');
  const offset = Number(uintWord(data, 0));
  const length = Number(BigInt(`0x${hex.slice(offset * 2, offset * 2 + 64)}`));
  const bytes = hex.slice(offset * 2 + 64, offset * 2 + 64 + length * 2);
  if (bytes.length !== length * 2) throw new Error('Truncated ABI string.');
  return new TextDecoder().decode(Uint8Array.from(bytes.match(/../g)?.map((v) => Number.parseInt(v, 16)) ?? []));
}

/** Decode TokenData[] = tuple(string symbol,address tokenAddress)[]. */
export function decodeReserveTokens(data: string): Array<{ symbol: string; address: string }> {
  const hex = strip0x(data);
  const arrayOffset = Number(uintWord(data, 0));
  const length = Number(BigInt(`0x${hex.slice(arrayOffset * 2, arrayOffset * 2 + 64)}`));
  if (!Number.isSafeInteger(length) || length < 0 || length > 256) throw new Error('Malformed reserve list length.');
  const headStart = arrayOffset + 32;
  return Array.from({ length }, (_, index) => {
    const relative = Number(BigInt(`0x${hex.slice((headStart + index * 32) * 2, (headStart + index * 32 + 32) * 2)}`));
    const tupleStart = headStart + relative;
    const stringRelative = Number(BigInt(`0x${hex.slice(tupleStart * 2, (tupleStart + 32) * 2)}`));
    const addressHex = hex.slice((tupleStart + 32) * 2, (tupleStart + 64) * 2);
    if (!/^0{24}[0-9a-fA-F]{40}$/.test(addressHex)) throw new Error('Malformed reserve address.');
    const stringStart = tupleStart + stringRelative;
    const stringLength = Number(BigInt(`0x${hex.slice(stringStart * 2, (stringStart + 32) * 2)}`));
    const stringHex = hex.slice((stringStart + 32) * 2, (stringStart + 32 + stringLength) * 2);
    const symbol = new TextDecoder().decode(Uint8Array.from(stringHex.match(/../g)?.map((v) => Number.parseInt(v, 16)) ?? []));
    if (!symbol.trim()) throw new Error('Reserve symbol is missing.');
    return { symbol, address: `0x${addressHex.slice(24).toLowerCase()}` };
  });
}
