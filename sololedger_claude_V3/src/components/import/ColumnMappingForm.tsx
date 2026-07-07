import { useEffect, useState } from 'react';
import type { TxType } from '@/types/transaction';
import {
  parseWithMapping,
  guessTypeValueMap,
  type ColumnMapping
} from '@/lib/parsers/generic';
import { suggestCsvMappingWithAi } from '@/lib/ai/csvMapping';
import { getSettings } from '@/lib/storage/db';
import { Button } from '@/components/ui/button';
import { Sparkles, HelpCircle } from 'lucide-react';

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

function FieldHint({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex align-middle">
      <HelpCircle className="h-3.5 w-3.5 cursor-help text-mist-400" />
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 hidden w-56 -translate-x-1/2 rounded-lg border border-ink-600 bg-ink-900 px-2 py-1.5 text-[11px] font-normal normal-case leading-snug text-mist-300 shadow-xl group-hover:block">
        {text}
      </span>
    </span>
  );
}

function noneOption(headers: string[], value: string, onChange: (v: string) => void, label: string, hint: string) {
  return (
    <label className="text-xs text-mist-400">
      {label}
      <FieldHint text={hint} />
      <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— none —</option>
        {headers.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
    </label>
  );
}

export function ColumnMappingForm({ headers, rows, onMapped }: Props) {
  const [timestamp, setTimestamp] = useState('');
  const [typeCol, setTypeCol] = useState('');
  const [asset, setAsset] = useState('');
  const [amount, setAmount] = useState('');
  const [totalValue, setTotalValue] = useState('');
  const [pricePerUnit, setPricePerUnit] = useState('');
  const [fiatValue, setFiatValue] = useState('');
  const [fiatCurrency, setFiatCurrency] = useState('');
  const [feeAmount, setFeeAmount] = useState('');
  const [feeAsset, setFeeAsset] = useState('');
  const [assetIsTradingPair, setAssetIsTradingPair] = useState(true);
  const [typeValueMap, setTypeValueMap] = useState<Record<string, TxType>>({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);

  useEffect(() => {
    const lower = headers.map((h) => h.toLowerCase());
    const pick = (...candidates: string[]) => {
      for (const c of candidates) {
        const i = lower.findIndex((h) => h.includes(c));
        if (i >= 0) return headers[i];
      }
      return '';
    };
    setTimestamp(pick('time', 'date', 'utc'));
    setTypeCol(pick('side', 'type', 'operation'));
    setAsset(pick('pair', 'symbol', 'coin', 'asset', 'currency'));
    setAmount(pick('amount', 'qty', 'quantity', 'executed'));
    setTotalValue(pick('total', 'quote', 'value'));
    setPricePerUnit(pick('price', 'avg'));
    setFiatValue(pick('fiat', 'cost', 'proceeds'));
    setFeeAmount(pick('fee', 'commission'));
    setFeeAsset(pick('fee coin', 'commissionasset', 'feecurrency'));
  }, [headers]);

  const distinctTypeValues = Array.from(
    new Set(rows.map((r) => (typeCol ? (r[typeCol] || '').trim() : '')).filter(Boolean))
  ).slice(0, 30);

  useEffect(() => {
    if (!typeCol || distinctTypeValues.length === 0) return;
    setTypeValueMap((prev) => ({ ...guessTypeValueMap(distinctTypeValues), ...prev }));
  }, [typeCol, distinctTypeValues.join('|')]);

  const runAiMapping = async () => {
    setAiLoading(true);
    setAiMsg(null);
    try {
      const settings = await getSettings();
      if (!settings.aiApiKey) {
        setAiMsg('Add your OpenRouter API key in Settings → AI Advisor to use AI mapping.');
        return;
      }
      const suggestion = await suggestCsvMappingWithAi(
        settings.aiApiKey,
        headers,
        rows,
        settings.aiModel
      );
      const m = suggestion.mapping;
      if (m.timestamp) setTimestamp(m.timestamp);
      if (m.type) setTypeCol(m.type);
      if (m.asset) setAsset(m.asset);
      if (m.amount) setAmount(m.amount);
      setTotalValue(m.totalValue ?? '');
      setPricePerUnit(m.pricePerUnit ?? '');
      setFiatValue(m.fiatValue ?? '');
      setFiatCurrency(m.fiatCurrency ?? '');
      setFeeAmount(m.feeAmount ?? '');
      setFeeAsset(m.feeAsset ?? '');
      if (m.assetIsTradingPair != null) setAssetIsTradingPair(m.assetIsTradingPair);
      if (m.typeValueMap) setTypeValueMap(m.typeValueMap);
      setAiMsg(`AI (${suggestion.confidence} confidence): ${suggestion.explanation}`);
    } catch (err) {
      setAiMsg(err instanceof Error ? err.message : 'AI mapping failed.');
    } finally {
      setAiLoading(false);
    }
  };

  const runMapping = async () => {
    const settings = await getSettings();
    const mapping: ColumnMapping = {
      timestamp,
      type: typeCol,
      asset,
      amount,
      totalValue: totalValue || undefined,
      pricePerUnit: pricePerUnit || undefined,
      fiatValue: fiatValue || undefined,
      fiatCurrency: fiatCurrency || undefined,
      feeAmount: feeAmount || undefined,
      feeAsset: feeAsset || undefined,
      assetIsTradingPair,
      typeValueMap
    };
    onMapped(parseWithMapping(rows, mapping, settings.reportingCurrency));
  };

  const mappedTypeCount = distinctTypeValues.filter((v) => typeValueMap[v.toLowerCase()]).length;
  const ready = !!(timestamp && typeCol && asset && amount && mappedTypeCount > 0);

  return (
    <div className="space-y-4 rounded-lg border border-ink-700 bg-ink-800/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-mist-300">
          Map your file's columns to the fields SoloLedger needs. Only <strong>date, type, asset, and quantity</strong>{' '}
          are required — fiat and fee columns are optional. Trading pairs like SOLUSDT are split automatically.
        </p>
        <Button variant="secondary" disabled={aiLoading} onClick={() => void runAiMapping()} className="shrink-0">
          <Sparkles className="mr-1.5 h-4 w-4" />
          {aiLoading ? 'AI mapping…' : 'Auto-map with AI'}
        </Button>
      </div>

      {aiMsg && (
        <p className={`text-xs ${aiMsg.includes('failed') || aiMsg.includes('Add your') ? 'text-gold-600' : 'text-emerald-600'}`}>
          {aiMsg}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-mist-400">
          Date / time column
          <FieldHint text="When the trade happened — e.g. Date(UTC), Time, Timestamp. Not a duration field." />
          <select className={selectCls} value={timestamp} onChange={(e) => setTimestamp(e.target.value)}>
            <option value="">— select —</option>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-mist-400">
          Transaction type column
          <FieldHint text="Column with BUY, SELL, deposit, etc. Map each value to a SoloLedger type below." />
          <select className={selectCls} value={typeCol} onChange={(e) => setTypeCol(e.target.value)}>
            <option value="">— select —</option>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-mist-400">
          Asset / pair column
          <FieldHint text="Ticker (BTC) or trading pair (SOLUSDT). Pairs are split into base asset + quote for calculations." />
          <select className={selectCls} value={asset} onChange={(e) => setAsset(e.target.value)}>
            <option value="">— select —</option>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          <label className="mt-1 flex items-center gap-1.5 text-[11px] text-mist-400">
            <input
              type="checkbox"
              checked={assetIsTradingPair}
              onChange={(e) => setAssetIsTradingPair(e.target.checked)}
            />
            Values are trading pairs (e.g. SOLUSDT → SOL)
          </label>
        </label>
        <label className="text-xs text-mist-400">
          Quantity column
          <FieldHint text="Number of coins bought or sold — NOT price per coin. Binance: use 'Amount' or 'Executed', not 'Price'." />
          <select className={selectCls} value={amount} onChange={(e) => setAmount(e.target.value)}>
            <option value="">— select —</option>
            {headers.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </label>
        {noneOption(headers, totalValue, setTotalValue, 'Total value column (optional)', 'Total fiat/stable paid or received — Binance "Total". Best for tax value.')}
        {noneOption(headers, pricePerUnit, setPricePerUnit, 'Price per unit (optional)', 'Price of one coin. Fiat = price × quantity if Total column is missing.')}
        {noneOption(headers, fiatValue, setFiatValue, 'Fiat value column (optional)', 'Explicit value in your file currency. Overrides Total/Price×Qty.')}
        {noneOption(headers, fiatCurrency, setFiatCurrency, 'Currency column (optional)', 'USD, USDT, INR, etc. Defaults to quote currency from pair or Settings.')}
        {noneOption(headers, feeAmount, setFeeAmount, 'Fee amount (optional)', 'Trading fee amount.')}
        {noneOption(headers, feeAsset, setFeeAsset, 'Fee asset (optional)', 'Asset the fee was paid in — e.g. BNB, USDT.')}
      </div>

      <div className="rounded-lg bg-ink-900/50 px-3 py-2 text-xs text-mist-400">
        <strong className="text-mist-300">No fiat column?</strong> After import, go to Review →{' '}
        <em>Fetch missing prices</em> (Settings → Live price lookup + CoinGecko key). Prices are fetched by{' '}
        <strong>asset + date</strong> and converted to your reporting currency (Settings → jurisdiction).
      </div>

      {typeCol && distinctTypeValues.length > 0 && (
        <div>
          <p className="mb-2 text-xs text-mist-400">
            Map each value in "{typeCol}" to a SoloLedger type ({mappedTypeCount}/{distinctTypeValues.length} mapped):
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {distinctTypeValues.map((val) => (
              <div key={val} className="flex items-center gap-2">
                <span className="w-32 truncate font-mono text-xs text-mist-300" title={val}>{val}</span>
                <select
                  className={`${selectCls} mt-0`}
                  value={typeValueMap[val.toLowerCase()] ?? ''}
                  onChange={(e) =>
                    setTypeValueMap((prev) => ({ ...prev, [val.toLowerCase()]: e.target.value as TxType }))
                  }
                >
                  <option value="">— skip row —</option>
                  {TX_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <Button disabled={!ready} onClick={() => void runMapping()}>
        Parse with this mapping
      </Button>
      {!ready && (
        <p className="text-xs text-mist-400">
          Select date, type, asset, quantity columns and map at least one type value (e.g. BUY → buy).
        </p>
      )}
    </div>
  );
}
