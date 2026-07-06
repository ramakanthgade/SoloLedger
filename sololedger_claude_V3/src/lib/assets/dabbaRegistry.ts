/**
 * Dabba Network (DBT token) known on-chain program addresses.
 *
 * Sourced from: https://metrics.dabba.network/ (Jul 2026)
 * Full addresses are confirmed on Solscan for the token mint; program
 * addresses are matched by prefix + suffix since the live site shows them
 * in truncated form (e.g. "4ztP…6iJP"). A 4+4 character prefix+suffix match
 * on a 44-char base58 address gives ~58^8 ≈ 7×10¹4 unique combinations —
 * collision risk is negligible.
 *
 * When any of these addresses appears as the counterpartyAddress on a DBT
 * transfer_in, the transaction is automatically classified as `income`.
 */

/** Official DBT SPL token mint on Solana mainnet. */
export const DBT_TOKEN_MINT = 'DBTNHU51SBFi3dsoGGCRfKbno4teZXqsDSL37s4jgRKv';

export type DabbaIncomeKind =
  | 'genesis_reward'   // per-dabba daily vest from community genesis allocation
  | 'staking_reward'   // APY reward from wallet or allocation staking
  | 'airdrop'          // referral/mapping rewards, loot box, other campaigns
  | 'mainnet_reward';  // emission rewards claimed via claimRewardsMainnet

export interface DabbaProgramEntry {
  /** Human-readable label for the UI. */
  label: string;
  /** Tax classification kind. */
  kind: DabbaIncomeKind;
  /** First 4 chars of the Solana address. */
  prefix: string;
  /** Last 4 chars of the Solana address. */
  suffix: string;
  /** Notes about this program, shown in the transaction notes field. */
  notes: string;
}

/**
 * All known Dabba Network program and vault addresses.
 * Source: https://metrics.dabba.network/
 */
export const DABBA_PROGRAMS: DabbaProgramEntry[] = [
  {
    label: 'Dabba Daily Reward Treasury',
    kind: 'mainnet_reward',
    prefix: '4ztP',
    suffix: '6iJP',
    notes: 'Daily DBT emission treasury — rewards minted here and claimed by operators/owners/customers.'
  },
  {
    label: 'Dabba APY Reward Vault (Staking Program)',
    kind: 'staking_reward',
    prefix: 'STKa',
    suffix: 'zUZy',
    notes: 'Dabba staking program APY vault — rewards for wallet and allocation staking positions.'
  },
  {
    label: 'Dabba Airdrop Rewards Account',
    kind: 'airdrop',
    prefix: '5VCq',
    suffix: 'a8sD',
    notes: 'Paid out all referral and dabba-mapping rewards.'
  },
  {
    label: 'Dabba Loot Box Campaign',
    kind: 'airdrop',
    prefix: '6D1A',
    suffix: 'mNJq',
    notes: 'Source wallet for all Loot Box Campaign reward distributions.'
  },
  {
    label: 'Dabba Staking Operator',
    kind: 'staking_reward',
    prefix: 'J1WQ',
    suffix: 'mfSE',
    notes: 'Dabba staking operator program.'
  },
  {
    label: 'Dabba Reward Depositer',
    kind: 'mainnet_reward',
    prefix: 'GiW2',
    suffix: 'dH6r',
    notes: 'Dabba reward depositer — routes daily emissions into reward accounts.'
  },
  {
    label: 'Dabba claimRewardsMainnet Program',
    kind: 'mainnet_reward',
    prefix: 'GtF5',
    suffix: 'MqA4',
    notes: 'On-chain program for operators, bandwidth providers, and customers to claim earned DBT.'
  }
];

/** Check if an address matches a known Dabba program (prefix+suffix). */
export function identifyDabbaProgram(address: string): DabbaProgramEntry | null {
  for (const entry of DABBA_PROGRAMS) {
    if (address.startsWith(entry.prefix) && address.endsWith(entry.suffix)) {
      return entry;
    }
  }
  return null;
}

/** True if the SPL token contract address is the DBT mint. */
export function isDbtToken(contractAddress?: string): boolean {
  return contractAddress === DBT_TOKEN_MINT;
}

/**
 * For a DBT transfer_in from a known Dabba program, returns the income classification.
 * Returns null if not a DBT token or the sender is not a known program.
 */
export function classifyDbtIncome(
  contractAddress?: string,
  counterpartyAddress?: string
): { kind: DabbaIncomeKind; label: string; notes: string } | null {
  if (!isDbtToken(contractAddress)) return null;
  if (!counterpartyAddress) return null;

  const program = identifyDabbaProgram(counterpartyAddress);
  if (!program) return null;

  return { kind: program.kind, label: program.label, notes: program.notes };
}

/** Income kind → category string for display. */
export const DABBA_KIND_LABEL: Record<DabbaIncomeKind, string> = {
  genesis_reward: 'Dabba Genesis Reward',
  staking_reward: 'Dabba Staking Reward',
  airdrop: 'Dabba Campaign / Airdrop',
  mainnet_reward: 'Dabba Mainnet Reward'
};
