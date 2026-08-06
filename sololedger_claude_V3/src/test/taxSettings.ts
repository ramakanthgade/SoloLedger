import type { TaxSettings } from '@/types/transaction';

export const TEST_TAX_SETTINGS: TaxSettings = {
  jurisdiction: 'US',
  reportingCurrency: 'USD',
  defaultCostBasisMethod: 'FIFO',
  priceApiEnabled: false,
  rpcLookupEnabled: false
};
