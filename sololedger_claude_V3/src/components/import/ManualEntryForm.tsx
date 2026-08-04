import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { db } from '@/lib/storage/db';
import { makeId } from '@/lib/parsers/types';
import type { Transaction, TxType } from '@/types/transaction';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BrandIcon, symbolIconId } from '@/components/connections/brandIcons';
import { requiresMarketValue } from '@/lib/transactions/requiresMarketValue';

const TX_TYPES: TxType[] = [
  'buy', 'sell', 'trade', 'transfer_in', 'transfer_out', 'income',
  'gift_sent', 'gift_received', 'fee', 'nft_mint', 'nft_buy', 'nft_sell',
  'defi_deposit', 'defi_withdraw', 'other'
];

/** Friendly type chips (mockup `manual-type-chips`) mapped to real TxTypes. */
const CHIP_TYPES: Array<{ label: string; value: TxType }> = [
  { label: 'Buy', value: 'buy' },
  { label: 'Sell', value: 'sell' },
  { label: 'Send', value: 'transfer_out' },
  { label: 'Receive', value: 'transfer_in' },
  { label: 'Swap', value: 'trade' },
  { label: 'Reward', value: 'income' }
];

/** Quick-pick assets with a real brand glyph (same registry as the cards). */
const ASSET_SUGGESTIONS = ['BTC', 'ETH', 'SOL', 'USDT', 'BNB', 'USDC'];

const inputCls =
  'mt-1.5 block w-full rounded-lg border border-hi/10 bg-elev-2 px-3 py-2.5 text-sm text-hi placeholder:text-faint focus:border-primary focus:outline-none';

const labelCls = 'block text-xs font-semibold text-mid';

/**
 * ManualEntryForm (Connections v2 `cv2-manual-entry`) — one transaction typed
 * in by hand, now a first-class source inside the Add-data drawer. Type is a
 * friendly chip row (Buy/Sell/Send/Receive/Swap/Reward) with the full TxType
 * list behind "More"; the asset field shows the real brand glyph when the
 * symbol is known. Save logic is unchanged: db.transactions.put with
 * source 'manual' (+ missing_market_value when its classification requires FMV).
 */
export function ManualEntryForm({ onSaved }: { onSaved: () => void }) {
  const [type, setType] = useState<TxType>('buy');
  const [moreOpen, setMoreOpen] = useState(false);
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
  const isChipType = CHIP_TYPES.some((c) => c.value === type);
  const assetIcon = symbolIconId(asset.trim().toUpperCase());
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
      flags: fiatValue || !requiresMarketValue(type) ? [] : ['missing_market_value'],
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
    <div className="space-y-4" data-testid="manual-entry-form">
      {/* Type chips + full list behind "More" */}
      <div>
        <span className={labelCls} id="manual-type-label">
          Type
        </span>
        <div
          role="radiogroup"
          aria-labelledby="manual-type-label"
          className="mt-1.5 flex flex-wrap gap-1.5"
          data-testid="manual-type-chips"
        >
          {CHIP_TYPES.map((chip) => (
            <button
              key={chip.value}
              type="button"
              role="radio"
              aria-checked={type === chip.value}
              onClick={() => setType(chip.value)}
              className={cn(
                'inline-flex h-9 items-center rounded-full border px-3.5 text-[13px] font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                type === chip.value
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-hi/10 bg-elev-1 text-mid hover:bg-elev-3 hover:text-hi'
              )}
            >
              {chip.label}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={!isChipType}
            onClick={() => setMoreOpen(true)}
            className={cn(
              'inline-flex h-9 items-center gap-1 rounded-full border px-3.5 text-[13px] font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
              !isChipType
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-hi/10 bg-elev-1 text-mid hover:bg-elev-3 hover:text-hi'
            )}
          >
            {!isChipType ? type.replace(/_/g, ' ') : 'More'}
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        {(moreOpen || !isChipType) && (
          <select
            aria-label="All transaction types"
            className={inputCls}
            value={type}
            onChange={(e) => setType(e.target.value as TxType)}
          >
            {TX_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          Date
          <input
            type="date"
            className={inputCls}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className={labelCls}>
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
      </div>

      {/* Asset with brand-glyph preview + quick picks */}
      <div>
        <label className={labelCls} htmlFor="manual-asset">
          Asset
        </label>
        <div className="relative mt-1.5">
          {assetIcon && (
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
              <BrandIcon id={assetIcon} fallback={asset} size={20} />
            </span>
          )}
          <input
            id="manual-asset"
            placeholder="BTC"
            className={cn(inputCls, 'mt-0', assetIcon && 'pl-9')}
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {ASSET_SUGGESTIONS.map((sym) => (
            <button
              key={sym}
              type="button"
              onClick={() => setAsset(sym)}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                asset.trim().toUpperCase() === sym
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-hi/10 bg-elev-1 text-low hover:bg-elev-3 hover:text-hi'
              )}
            >
              <BrandIcon id={symbolIconId(sym)} fallback={sym} size={14} />
              {sym}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          Worth then (total)
          <input
            type="number"
            step="any"
            placeholder="optional"
            className={inputCls}
            value={fiatValue}
            onChange={(e) => setFiatValue(e.target.value)}
          />
        </label>
        <label className={labelCls}>
          Fiat currency
          <input
            className={inputCls}
            value={fiatCurrency}
            onChange={(e) => setFiatCurrency(e.target.value)}
          />
        </label>
      </div>

      {isTrade && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            Received asset (counter)
            <input
              placeholder="ETH"
              className={inputCls}
              value={counterAsset}
              onChange={(e) => setCounterAsset(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            Received amount (counter)
            <input
              type="number"
              step="any"
              className={inputCls}
              value={counterAmount}
              onChange={(e) => setCounterAmount(e.target.value)}
            />
          </label>
        </div>
      )}

      <label className={labelCls}>
        Notes <span className="font-normal text-faint">(optional)</span>
        <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      {/* Form footer (mockup dfoot) — sticky within the drawer body. */}
      <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-hi/10 bg-elev-1 px-4 py-3">
        <Button className="w-full" disabled={!valid} onClick={save} data-testid="manual-submit">
          <Check className="h-4 w-4" aria-hidden="true" /> Add to ledger
        </Button>
        <p className="mt-2 text-center text-xs text-low">
          {saved ? (
            <span className="font-semibold text-gain">Saved.</span>
          ) : (
            'Lands in Transactions under “Manual entry” — edit or delete anytime.'
          )}
        </p>
      </div>
    </div>
  );
}
