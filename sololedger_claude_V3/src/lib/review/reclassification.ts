import type { Transaction, TxType } from '@/types/transaction';

const OPTIONS_TYPES_BY_CATEGORY: Readonly<Record<string, readonly TxType[]>> = {
  options_premium: ['fee', 'income'],
  options_fee: ['fee', 'income'],
  options_collateral: ['transfer_in', 'transfer_out']
};

/**
 * Clear parser-supplied Options classification when a user's new type no
 * longer represents that cash-journal shape. Other categories, notably the
 * `defi_reward` rejection marker, deliberately remain untouched.
 */
export function reclassifiedOptionsPatch(
  transaction: Pick<Transaction, 'category' | 'instrumentClass'>,
  next: TxType
): Pick<Partial<Transaction>, 'category' | 'instrumentClass'> {
  const allowedTypes = transaction.category
    ? OPTIONS_TYPES_BY_CATEGORY[transaction.category]
    : undefined;
  if (!allowedTypes || allowedTypes.includes(next)) return {};
  return {
    category: undefined,
    instrumentClass: transaction.instrumentClass === 'derivative'
      ? undefined
      : transaction.instrumentClass
  };
}
