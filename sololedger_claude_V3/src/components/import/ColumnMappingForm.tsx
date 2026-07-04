import { useState } from 'react';
import type { TxType } from '@/types/transaction';
import { parseWithMapping, type ColumnMapping } from '@/lib/parsers/generic';
import { Button } from '@/components/ui/button';

const TX_TYPES: TxType[] = [
  'buy', 'sell', 'trade', 'transfer_in', 'transfer_out', 'income',
  'gift_sent', 'gift_received', 'fee', 'nft_mint', 'nft_buy', 'nft_sell',
  'defi_deposit', 'defi_withdraw', 'other'
];

interface Props {
  headers: string[];
  rows: Record<string, string>[];
  onMapped: (transactions: ReturnType<typeof parseWithMapping>) => void;
}

const selectCls =
  'mt-1 block w-full rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-sm text-mist focus:border-emerald focus:outline-none';

export function ColumnMappingForm({ headers, rows, onMapped }: Props) {
  const [timestamp, setTimestamp] = useState(headers[0] ?? '');
  const [typeCol, setTypeCol] = useState(headers[0] ?? '');
  const [asset, setAsset] = useState(headers[0] ?? '');
  const [amount, setAmount] = useState(headers[0] ?? '');
  const [fiatValue, setFiatValue] = useState('');
  const [fiatCurrency] = useState('');
  const [feeAmount, setFeeAmount] = useState('');

  const distinctTypeValues = Array.from(new Set(rows.map((r) => (r[typeCol] || '').trim()))).filter(Boolean).slice(0, 30);
  const [typeValueMap, setTypeValueMap] = useState<Record<string, TxType>>({});

  const runMapping = () => {
    const mapping: ColumnMapping = {
      timestamp,
      type: typeCol,
      asset,
      amount,
      fiatValue: fiatValue || undefined,
      fiatCurrency: fiatCurrency || undefined,
      feeAmount: feeAmount || undefined,
      typeValueMap
    };
    onMapped(parseWithMapping(rows, mapping));
  };

  const ready = timestamp && typeCol && asset && amount && Object.keys(typeValueMap).length > 0;

  return (
    <div className="space-y-4 rounded-lg border border-ink-700 bg-ink-800/40 p-4">
      <p className="text-sm text-mist-300">
        Map your file's columns to the fields SoloLedger needs. This runs entirely in your browser against the file
        already on disk — nothing is re-uploaded.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-mist-400">
          Date / time column
          <select className={selectCls} value={timestamp} onChange={(e) => setTimestamp(e.target.value)}>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-mist-400">
          Transaction type column
          <select className={selectCls} value={typeCol} onChange={(e) => setTypeCol(e.target.value)}>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-mist-400">
          Asset / ticker column
          <select className={selectCls} value={asset} onChange={(e) => setAsset(e.target.value)}>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-mist-400">
          Amount column
          <select className={selectCls} value={amount} onChange={(e) => setAmount(e.target.value)}>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-mist-400">
          Fiat value column (optional)
          <select className={selectCls} value={fiatValue} onChange={(e) => setFiatValue(e.target.value)}>
            <option value="">— none —</option>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-mist-400">
          Fee column (optional)
          <select className={selectCls} value={feeAmount} onChange={(e) => setFeeAmount(e.target.value)}>
            <option value="">— none —</option>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
      </div>

      {typeCol && distinctTypeValues.length > 0 && (
        <div>
          <p className="mb-2 text-xs text-mist-400">
            Map each value found in "{typeCol}" to a SoloLedger transaction type:
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {distinctTypeValues.map((val) => (
              <div key={val} className="flex items-center gap-2">
                <span className="w-32 truncate font-mono text-xs text-mist-300" title={val}>{val}</span>
                <select
                  className={selectCls + ' mt-0'}
                  value={typeValueMap[val.toLowerCase()] ?? ''}
                  onChange={(e) =>
                    setTypeValueMap((prev) => ({ ...prev, [val.toLowerCase()]: e.target.value as TxType }))
                  }
                >
                  <option value="">— skip —</option>
                  {TX_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <Button disabled={!ready} onClick={runMapping}>
        Parse with this mapping
      </Button>
    </div>
  );
}
