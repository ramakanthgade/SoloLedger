import type { Transaction } from '@/types/transaction';

/**
 * All hashing happens locally via SubtleCrypto — nothing is sent anywhere.
 * Used to turn wallet addresses / tx hashes into short, consistent
 * pseudonyms so a report can be shared with an accountant without exposing
 * raw on-chain identifiers, while still letting duplicate references match.
 */
async function pseudonymize(value: string, salt: string): Promise<string> {
  const enc = new TextEncoder().encode(salt + ':' + value);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 10);
}

export type DeidentifyMode = 'off' | 'pseudonymize' | 'summary_only';

export interface DeidentifyOptions {
  mode: DeidentifyMode;
  /** Random per-export salt so pseudonyms can't be correlated across separate reports. */
  salt: string;
}

export async function deidentifyTransactions(
  transactions: Transaction[],
  options: DeidentifyOptions
): Promise<Transaction[]> {
  if (options.mode === 'off') return transactions;

  const out: Transaction[] = [];
  for (const tx of transactions) {
    const clone: Transaction = { ...tx };
    if (clone.walletAddress) {
      clone.walletAddress = await pseudonymize(clone.walletAddress, options.salt);
    }
    if (clone.sourceRef) {
      clone.sourceRef = await pseudonymize(clone.sourceRef, options.salt);
    }
    clone.notes = clone.notes ? '[redacted]' : undefined;
    clone.raw = undefined;
    out.push(clone);
  }
  return out;
}
