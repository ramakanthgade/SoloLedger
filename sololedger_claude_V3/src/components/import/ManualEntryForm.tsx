import { useState } from 'react';
import { db } from '@/lib/storage/db';
import { makeId } from '@/lib/parsers/types';
import type { Transaction, TxType } from '@/types/transaction';
import { Button } from '@/components/ui/button';

const TX_TYPES: TxType[] = [
  'buy', 'sell', 'trade', 'transfer_in', 'transfer_out', 'income',
  'gift_sent', 'gift_received', 'fee', 'nft_mint', 'nft_buy', 'nft_sell',
  'defi_deposit', 'defi_withdraw', 'other'
];

const inputCls =
  'mt-1 block w-full rounded border border-white/10 bg-elev-2 px-2 py-1.5 text-sm text-mid focus:border-violet focus:outline-none';

export function ManualEntryForm({ onSaved }: { onSaved: () => void }) {
  const [type, setType] = useState<TxType>('buy');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [fiatValue, setFiatValue] = useState('');
  const [fiatCurrency, setFiatCurrency] = useState('USD');
  const [counterAsset, setCounterAsset] = useState('');
  const [counterAmount, setCounterAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState(false);

  const isTrade = type === 'trade';
  const valid = asset.trim() && Number(amount) > 0 && date;

  const save = async () => {
    const tx: Transaction = {
      id: makeId('manual'),
      timestamp: new Date(date).getTime(),
      type,
      asset: asset.trim().toUpperCase(),
      amount: Number(amount),
      fiatCurrency,
      fiatValue: fiatValue ? Number(fiatValue) : undefined,
      counterAsset: isTrade && counterAsset ? counterAsset.trim().toUpperCase() : undefined,
      counterAmount: isTrade && counterAmount ? Number(counterAmount) : undefined,
      source: 'manual',
      notes: notes || undefined,
      flags: fiatValue ? [] : ['missing_cost_basis'],
      isInternalTransfer: false
    };
    await db.transactions.put(tx);
    setSaved(true);
    setAsset('');
    setAmount('');
    setFiatValue('');
    setCounterAsset('');
    setCounterAmount('');
    setNotes('');
    onSaved();
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-4 rounded-lg border border-white/10 bg-elev-2/40 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-low">
          Type
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as TxType)}>
            {TX_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-low">
          Date
          <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="text-xs text-low">
          Asset
          <input placeholder="BTC" className={inputCls} value={asset} onChange={(e) => setAsset(e.target.value)} />
        </label>
        <label className="text-xs text-low">
          Amount
          <input
            type="number"
            step="any"
            placeholder="0.5"
            className={inputCls}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="text-xs text-low">
          Fiat value
          <input
            type="number"
            step="any"
            placeholder="optional"
            className={inputCls}
            value={fiatValue}
            onChange={(e) => setFiatValue(e.target.value)}
          />
        </label>
        <label className="text-xs text-low">
          Fiat currency
          <input className={inputCls} value={fiatCurrency} onChange={(e) => setFiatCurrency(e.target.value)} />
        </label>
        {isTrade && (
          <>
            <label className="text-xs text-low">
              Received asset (counter)
              <input
                placeholder="ETH"
                className={inputCls}
                value={counterAsset}
                onChange={(e) => setCounterAsset(e.target.value)}
              />
            </label>
            <label className="text-xs text-low">
              Received amount (counter)
              <input
                type="number"
                step="any"
                className={inputCls}
                value={counterAmount}
                onChange={(e) => setCounterAmount(e.target.value)}
              />
            </label>
          </>
        )}
        <label className="text-xs text-low sm:col-span-3">
          Notes
          <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button disabled={!valid} onClick={save}>
          Add transaction
        </Button>
        {saved && <span className="text-xs text-gain">Saved.</span>}
      </div>
    </div>
  );
}
