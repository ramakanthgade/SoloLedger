/**
 * AI-assisted CSV column mapping via OpenRouter.
 * Sends headers + sample rows only — never the full file if large.
 */
import { completeChat, DEFAULT_AI_MODEL } from '@/lib/ai/openrouter';
import type { ColumnMapping } from '@/lib/parsers/generic';
import { guessTypeValueMap } from '@/lib/parsers/generic';
import type { TxType } from '@/types/transaction';

/** Required mapping fields that must resolve to a real header before import. */
export const REQUIRED_MAPPING_FIELDS = ['timestamp', 'type', 'asset', 'amount'] as const;
export type RequiredMappingField = (typeof REQUIRED_MAPPING_FIELDS)[number];

export interface AiMappingSuggestion {
  mapping: Partial<ColumnMapping>;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  /** True only when every required field resolved to a real header. */
  valid: boolean;
  /** Required fields the AI could not confidently map — the UI must gate on this. */
  missingFields: RequiredMappingField[];
}

const VALID_TYPES = new Set<TxType>([
  'buy', 'sell', 'trade', 'transfer_in', 'transfer_out', 'income',
  'gift_sent', 'gift_received', 'fee', 'nft_mint', 'nft_buy', 'nft_sell',
  'defi_deposit', 'defi_withdraw', 'other'
]);

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('AI did not return valid JSON.');
  return JSON.parse(raw.slice(start, end + 1));
}

export async function suggestCsvMappingWithAi(
  apiKey: string,
  headers: string[],
  sampleRows: Record<string, string>[],
  model = DEFAULT_AI_MODEL
): Promise<AiMappingSuggestion> {
  const samples = sampleRows.slice(0, 8).map((row) => {
    const slim: Record<string, string> = {};
    for (const h of headers) slim[h] = (row[h] ?? '').slice(0, 120);
    return slim;
  });

  const prompt = `You are a crypto tax CSV import assistant. Map exchange export columns to SoloLedger fields.

HEADERS: ${JSON.stringify(headers)}

SAMPLE ROWS (up to 8):
${JSON.stringify(samples, null, 2)}

FIELD RULES:
- timestamp: date/time of trade (NOT duration)
- type: column with BUY/SELL/deposit/withdraw values
- asset: ticker OR trading pair (e.g. SOLUSDT). Set assetIsTradingPair:true if pairs like SOLUSDT/BTCUSDT
- amount: QUANTITY of crypto bought/sold (Binance "Amount"/"Executed Qty") — NOT price per coin
- pricePerUnit: optional — price per one unit (Binance "Price")
- totalValue: optional — total fiat/stable value (Binance "Total"/"Quote Qty") — BEST for fiatValue
- fiatValue: optional column with explicit fiat value in file currency
- fiatCurrency: optional column with currency code (USD, USDT, INR)
- feeAmount / feeAsset: optional fee columns
- typeValueMap: map each distinct type cell value (lowercase keys) to one of: buy, sell, trade, transfer_in, transfer_out, income, fee, other

Return ONLY JSON:
{
  "timestamp": "column name",
  "type": "column name",
  "asset": "column name",
  "amount": "column name",
  "totalValue": "column name or null",
  "pricePerUnit": "column name or null",
  "fiatValue": "column name or null",
  "fiatCurrency": "column name or null",
  "feeAmount": "column name or null",
  "feeAsset": "column name or null",
  "assetIsTradingPair": true,
  "typeValueMap": { "buy": "buy", "sell": "sell" },
  "explanation": "one sentence for the user",
  "confidence": "high"
}`;

  const raw = await completeChat(apiKey, model, [
    {
      role: 'system',
      content:
        'You map cryptocurrency exchange CSV exports to tax software fields. Respond with JSON only. Be precise about amount vs price vs total.'
    },
    { role: 'user', content: prompt }
  ]);

  const parsed = extractJson(raw) as Record<string, unknown>;
  const typeValueMap: Record<string, TxType> = {};
  const rawMap = (parsed.typeValueMap ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(rawMap)) {
    const t = String(v).toLowerCase() as TxType;
    if (VALID_TYPES.has(t)) typeValueMap[k.toLowerCase()] = t;
  }

  const distinctTypes = [
    ...new Set(sampleRows.map((r) => (r[String(parsed.type)] || '').trim().toLowerCase()).filter(Boolean))
  ];
  const mergedTypeMap = { ...guessTypeValueMap(distinctTypes), ...typeValueMap };

  const pick = (key: string): string | undefined => {
    const v = parsed[key];
    if (v == null || v === 'null' || v === '') return undefined;
    const s = String(v);
    return headers.includes(s) ? s : headers.find((h) => h.toLowerCase() === s.toLowerCase());
  };

  // Resolve required fields to real headers only — NO `headers[0]` fallback.
  // A blind fallback silently mapped every unresolved required field onto the
  // first column, producing a plausible-looking but wrong import. Instead we
  // leave the field undefined and report it in `missingFields` so the UI can
  // force a preview/confirm (or manual correction) before persisting.
  const timestamp = pick('timestamp');
  const type = pick('type');
  const asset = pick('asset');
  const amount = pick('amount');

  const resolved: Record<RequiredMappingField, string | undefined> = {
    timestamp,
    type,
    asset,
    amount
  };
  const missingFields = REQUIRED_MAPPING_FIELDS.filter((f) => !resolved[f]);
  const valid = missingFields.length === 0;

  return {
    mapping: {
      timestamp: timestamp ?? '',
      type: type ?? '',
      asset: asset ?? '',
      amount: amount ?? '',
      totalValue: pick('totalValue'),
      pricePerUnit: pick('pricePerUnit'),
      fiatValue: pick('fiatValue'),
      fiatCurrency: pick('fiatCurrency'),
      feeAmount: pick('feeAmount'),
      feeAsset: pick('feeAsset'),
      assetIsTradingPair: parsed.assetIsTradingPair !== false,
      typeValueMap: mergedTypeMap
    },
    explanation: String(parsed.explanation ?? 'AI suggested column mapping applied.'),
    confidence: (['high', 'medium', 'low'].includes(String(parsed.confidence))
      ? String(parsed.confidence)
      : 'medium') as AiMappingSuggestion['confidence'],
    valid,
    missingFields
  };
}
