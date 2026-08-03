import type { TaxSettings, TxType } from '@/types/transaction';
import { DISPOSAL_TYPES } from './bulkEdit';

export function supportsSpecificIdEditing(type: TxType, method: TaxSettings['defaultCostBasisMethod']): boolean {
  return method === 'SpecID' && DISPOSAL_TYPES.has(type);
}
