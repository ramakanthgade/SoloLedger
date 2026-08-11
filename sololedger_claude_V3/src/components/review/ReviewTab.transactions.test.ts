import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Wiring guards for the 2026-07-25 live-feedback round (items 10 + 11 + the
 * needs-price grammar fix) — grep-based for the same reason as
 * ReviewTab.detectSwaps.test.ts: a full ReviewTab render never settles under
 * jsdom. The pure logic behind the wiring is unit-tested in
 * rowAnatomy.test.ts (flow model + summaries), spamVisibility.test.ts
 * (default-hide contract) and bulkEdit.test.ts (needsPriceLine).
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'ReviewTab.tsx'), 'utf8');
const brandSource = readFileSync(resolve(here, 'brandIcons.tsx'), 'utf8');

describe('ReviewTab — item 7/10: page renamed to Transactions', () => {
  it('renders the page title as Transactions (both the list and the empty state)', () => {
    const titles = source.match(/<h2 className="page-title">Transactions<\/h2>/g) ?? [];
    expect(titles.length).toBe(4);
    expect(source).not.toContain('<h2 className="page-title">Review</h2>');
  });
});

describe('ReviewTab — exact navigation ordering', () => {
  it('shows exact-target loading or missing feedback with Back before the generic empty ledger', () => {
    expect(source.indexOf("if (navigationError)")).toBeLessThan(source.indexOf('if (transactions.length === 0)'));
    expect(source.indexOf("if (navigationIntent?.transactionId && transactionsLive === undefined)")).toBeLessThan(source.indexOf('if (transactions.length === 0)'));
    expect(source).toContain('Locating the exact transaction…');
  });

  it('shows and clears the exact durable navigation scope as a real filter', () => {
    expect(source).toContain('navigationScopeFilter != null');
    expect(source).toContain('Remove exact navigation scope');
    expect(source).toContain('Exact scope · {navigationScopeFilter.accountClass');
    expect(source).toContain('setNavigationScopeFilter(null);');
    expect(source).toContain('navigationResetToken');
  });
});

describe('ReviewTab — item 11: spam hidden by default', () => {
  it('passes the showSpam state through to the shared row filter (default off)', () => {
    expect(source).toContain("const [showSpam, setShowSpam] = useState(false);");
    expect(source).toContain('filterRows(transactions, {');
    expect(source).toContain('showSpam,');
  });

  it('the Spam chip reads "Spam (N)" in both states with the total spam count', () => {
    expect(source).toContain('`Spam (${spamTxCount}) ✕`');
    expect(source).toContain('`Spam (${spamTxCount})`');
    expect(source).not.toContain('`Spam: ${spamTxCount}`');
  });

  it('counts the default (non-spam) view in the header pill', () => {
    expect(source).toContain('(transactions.length - spamTxCount).toLocaleString');
  });

  it('derives every dynamic option from one normal/spam surface and resets stale filters both ways', () => {
    expect(source).toContain("const spamAuditMode = showSpam || flagFilter === 'spam';");
    expect(source).toContain('activeTransactionSurface(transactions, spamAuditMode)');
    expect(source).toContain('getAvailableFys(activeSurface.map((t) => t.timestamp), jurisdiction)');
    expect(source).toContain('buildReviewWalletFilterOptions(activeSurface, sourcePresentations)');
    expect(source).toContain('buildReviewSourceFilterOptions(activeSurface, sourcePresentations)');
    expect(source).toContain('visibleAssetOptions(activeSurface)');
    expect(source).toContain('if (previousSpamAuditMode.current === spamAuditMode) return;');
    expect(source).toContain("setAssetFilter('all');");
    expect(source).toContain("setSourceFilter('all');");
    expect(source).toContain("setWalletFilter('all');");
    expect(source).toContain('setFyFilter(null);');
  });

  it('loads one decision snapshot before rows and cost analysis, and warning chips leave Spam mode', () => {
    expect(source).toContain('const safetyDecisionsLive = useLiveQuery(() => db.safetyDecisions.toArray(), []);');
    expect(source).toContain('transactionsUnderCurrentSafetyPolicy(transactionsLive, safetyDecisionsLive)');
    expect(source).toContain('safetyDecisions: safetyDecisionsLive');
    expect(source).toContain('transactionsLive === undefined || safetyDecisionsLive === undefined');
    const needsPriceHandler = source.slice(source.indexOf('aria-pressed={showNeedsPrice}'), source.indexOf('{needsReviewCount > 0'));
    const needsReviewHandler = source.slice(source.indexOf('aria-pressed={showNeedsReview}'), source.indexOf('{spamTxCount > 0'));
    expect(needsPriceHandler).toContain("setFlagFilter('all');");
    expect(needsReviewHandler).toContain("setFlagFilter('all');");
  });
});

describe('ReviewTab — item 10: richer rows + click-anywhere details', () => {
  it('drives the row-face flow and the Details summary from the pure rowAnatomy helpers', () => {
    expect(source).toContain("from './rowAnatomy'");
    expect(source).toContain('txFlow(t,');
    expect(source).toContain('buildTxSummary(t,');
  });

  it('clicking anywhere on the row face toggles the Details panel', () => {
    expect(source).toContain('onClick={() => setExpandedId((cur) => (cur === t.id ? null : t.id))}');
  });

  it('keeps the accessible expand/collapse button (keyboard path) with its aria state', () => {
    expect(source).toContain("aria-label={expanded ? 'Collapse transaction details' : 'Expand transaction details'}");
    expect(source).toContain('aria-expanded={expanded}');
  });

  it('stops row-internal controls from toggling the panel (stopPropagation)', () => {
    // The bulk-select label, both selector popovers and the chevron all swallow
    // the click so it cannot double-toggle the row's expansion.
    const stops = source.match(/e\.stopPropagation\(\)/g) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(4);
  });

  it('shows the facts grid with date, hash/order id, source, both legs, value, cost basis and gain', () => {
    expect(source).toContain('<DetailRow label="Date">');
    expect(source).toContain('<DetailRow label={hashFactLabel}>');
    expect(source).toContain('<DetailRow label="Source">');
    expect(source).toContain('<DetailRow label="From">');
    expect(source).toContain('<DetailRow label="To">');
    expect(source).toContain('<DetailRow label="Value">');
    expect(source).toContain('<DetailRow label="Cost basis">');
    expect(source).toContain('Review Cost Analysis');
    expect(source).toContain('[role="tab"][aria-controls="transaction-panel-cost"]');
    expect(source).toContain('<DetailRow label="Gain">');
  });

  it('resolves wallet names live from the lookup-address table (renames update rows in place)', () => {
    expect(source).toContain('db.lookupAddresses.toArray()');
    expect(source).toContain('buildWalletLabelMap(lookupAddresses)');
    expect(source).toContain('walletLabelFor(walletLabels, t, addr)');
  });
});

describe('ReviewTab — Koinly-inspired SoloLedger economic rows', () => {
  it('lays the row on seven aligned tracks with source classification at the left and utilities at the right', () => {
    // select · source/type/category · outgoing · arrow · incoming · utilities · disclosure.
    expect(source).toContain('lg:grid-cols-[auto_minmax(10rem,11rem)_minmax(10rem,1fr)_auto_minmax(10rem,1fr)_minmax(11rem,14rem)_auto]');
    expect(source).toContain('data-testid="tx-source-account"');
    expect(source).toContain('data-testid="tx-type-category"');
    expect(source).toContain('data-testid="tx-row-actions"');
  });

  it('shows wallet and chain identity above both economic legs', () => {
    expect(source).toContain("data-testid={side === 'sent' ? 'tx-sent-side' : 'tx-received-side'}");
    expect(source).toContain("{identity}{chainLabel ? ` · ${chainLabel}` : ''}");
    expect(source).not.toContain("side === 'sent' && t.fiatValue != null");
    expect(source).not.toContain('extraValue');
  });

  it('keeps type, category, time, and chain beside the source logo while right utilities retain fee and flags', () => {
    const sourceBlock = source.slice(source.indexOf('data-testid="tx-source-account"'), source.indexOf('data-testid="tx-flow"'));
    const actionsBlock = source.slice(source.indexOf('data-testid="tx-row-actions"'), source.indexOf('data-testid="tx-disclosure"'));
    expect(sourceBlock).toContain('<TypeSelector tx={t} />');
    expect(sourceBlock).toContain('<CategorySelector tx={t} />');
    expect(sourceBlock).toContain('data-testid="tx-time-chain"');
    expect(sourceBlock).toContain("{timeUtc}{chainLabel ? ` · ${chainLabel}` : ''}");
    expect(actionsBlock).not.toContain('<TypeSelector tx={t} />');
    expect(actionsBlock).not.toContain('<CategorySelector tx={t} />');
    expect(actionsBlock).not.toContain("{timeUtc}{chainLabel ? ` · ${chainLabel}` : ''}");
    expect(actionsBlock).toContain('fee {formatCompactAmount(t.feeAmount)} {t.feeAsset}');
    expect(actionsBlock).toContain('<FlagSelector tx={t} derivedFlags={derivedFlags} />');
  });

  it('puts hash copy and safe explorer conveniences on the row face', () => {
    expect(source).toContain('truncateAddress(hash)');
    expect(source).toContain('<CopyButton text={hash}');
    expect(source).toContain('aria-label="Open transaction in explorer"');
    expect(source).toContain('<ExternalLink className="h-3.5 w-3.5" />');
  });

  it('badges the source logo with the distinct chain brand', () => {
    expect(source).toContain("import { chainIconId } from '@/components/connections/brandIcons'");
    expect(source).toContain('<SourceIcon iconId={chainIconId(t.chain)}');
    expect(source).not.toContain('<AssetIcon symbol={chainDef.asset}');
  });

  it('uses matched-row missing status rather than treating every zero basis as missing', () => {
    expect(source).toContain("row.status === 'missing_cost_basis'");
    expect(source).not.toContain('pricedDisposal.costBasis > 0');
  });
});

describe('ReviewTab — grammar fix: needs-price banner is plural-aware', () => {
  it('delegates to needsPriceLine and no longer hardcodes "still need a price"', () => {
    expect(source).toContain('needsPriceLine(missingPriceTxs.length)');
    expect(source).not.toContain('still need a price');
  });
});

describe('ReviewTab — market value and acquisition basis are distinct', () => {
  it('clears only missing market value after manual pricing and labels the total field accurately', () => {
    expect(source).toContain('parseManualMarketValue(editValue)');
    expect(source).toContain("f !== 'missing_market_value'");
    expect(source).not.toContain("f !== 'missing_cost_basis'");
    expect(source).toContain('aria-label="Total transaction market value"');
    expect(source).toContain('Add market value');
  });

  it('offers a direct Cost Analysis action and hosted missing-basis guidance', () => {
    expect(source).toContain('Review Cost Analysis');
    expect(source).toContain("[t.id]: 'cost'");
    expect(source).toContain('transactions are missing cost basis');
    expect(source).toContain("setFlagFilter('missing_cost_basis')");
    expect(source).toContain('Automatic historical pricing was attempted');
    expect(source).toContain('A transaction market value is not a replacement for lot basis.');
  });

  it('includes runtime-derived flags in CSV, JSON, and PDF exports', () => {
    expect(source).toContain('displayFlags(t, derivedFlagsByTxId.get(t.id)).join(\'|\')');
    expect(source).toContain('flags: displayFlags(t, derivedFlagsByTxId.get(t.id))');
    expect(source).toContain('displayFlags(t, derivedFlagsByTxId.get(t.id)).join(\', \')');
  });
});

describe('ReviewTab — transaction reconciliation and mobile overlays', () => {
  it('does not reconcile custody history for collapsed rows', () => {
    expect(source).toContain('const reconciliation = expanded && principalPosting && selectedAuthority ? reconcileDerivedPostings({');
  });

  it('uses the shared linked-source evidence projection', () => {
    expect(source).toContain('buildReconciliationEvidenceIndexes(');
    expect(source).toContain('projectReconciliationCoverage(coverage, exchangeConnections)');
    expect(source).toContain('buildReviewReconciliationEvidence(evidenceIndexes, authoritySelectionNow)');
    expect(source).toContain('const reconciliationCoverage = authorityCoverageByScope.get(scopeKey) ?? selectedCoverage;');
  });

  it('keeps a wrapped bulk action bar above mobile navigation', () => {
    expect(source).toContain('data-testid="bulk-action-bar"');
    expect(source).toContain('bottom-20');
    expect(source).toContain('lg:bottom-5');
    expect(source).toContain("selected.size > 0 ? 'pb-64 lg:pb-28' : 'pb-28'");
  });
});

describe('ReviewTab — B2 exact presentation wiring', () => {
  it('builds presentation indexes from exact B1 rows and filters by stable source key', () => {
    expect(source).toContain('db.accountIdentities.toArray()');
    expect(source).toContain('db.csvImports.toArray()');
    expect(source).toContain('db.exchangeConnections.toArray()');
    expect(source).toContain('db.lookupAddresses.toArray()');
    expect(source).toContain('buildTransactionSourcePresentations(');
    expect(source).toContain('transactionMatchesSourceFilter(t, sourceFilter, sourcePresentations)');
  });

  it('shows exact labels/subtitles and source resolution in rows and details', () => {
    expect(source).toContain('sourcePresentation.primaryLabel');
    expect(source).toContain('sourcePresentation.subtitle');
    expect(source).toContain('presentation={sourcePresentation}');
    expect(source).toContain('taxPolicy={taxPolicy!}');
  });

  it('preserves pair status and navigates to the exact linked counterpart with restored focus', () => {
    expect(source).toContain('Internal transfer suggested');
    expect(source).toContain('Internal transfer confirmed');
    expect(source).toContain('Open linked counterpart');
    expect(source).toContain('row?.focus()');
    expect(source).toContain("row?.scrollIntoView?.({ block: 'center' })");
    expect(source).toContain('buildTransactionById(transactions)');
    expect(source).toContain('linkedCounterpartFor(t, transactionsById)');
    expect(source).toContain('transactionPage(counterpartOrder, linkedCounterpart.id, PAGE_SIZE)');
    expect(source).not.toContain('transactions.find((candidate) => candidate.id === t.linkedTransferId)');
  });

  it('clears incompatible source/type/date filters before rendering and focusing a cross-page counterpart', () => {
    const start = source.indexOf('const openLinkedCounterpart = () =>');
    const end = source.indexOf('\n    };', start);
    const action = source.slice(start, end);
    expect(action).toContain("setSourceFilter('all')");
    expect(action).toContain("setTypeFilter('all')");
    expect(action).toContain('setFyFilter(null)');
    expect(source).toContain('setPage(targetPage)');
    expect(source).toContain('pageRows.some((transaction) => transaction.id === pendingCounterpartFocus)');
  });

  it('uses accessible 44px expansion and counterpart targets', () => {
    expect(source).toContain("'col-start-3 row-start-1 grid h-11 w-11 shrink-0 place-items-center");
    expect(source).toContain('className="inline-flex min-h-[44px] items-center');
  });

  it('uses a neutral fiat icon instead of a mock currency glyph', () => {
    expect(source).toContain('<Banknote className="h-3.5 w-3.5" />');
    expect(source).not.toContain('fiatSymbol(');
  });

  it('passes transaction logo identity only to explicitly principal asset legs', () => {
    expect(source).toContain('principalAssetIdentityForLeg(leg, t)');
    expect(source).not.toContain('flow.sent.symbol === assetLabel');
    expect(source).not.toContain('flow.received.symbol === assetLabel');
  });
});

describe('brandIcons — icons always resolve', () => {
  it('uses the shared local registry and a neutral fallback instead of mock letters or currency glyphs', () => {
    expect(brandSource).toContain("from '@/components/connections/brandIcons'");
    expect(brandSource).toContain('icon unavailable');
    expect(brandSource).toContain('onError={() => setLoadFailed(true)}');
    expect(brandSource).not.toContain('chipInitials');
    expect(brandSource).not.toContain('SIMPLEICONS_CDN');
    expect(brandSource).not.toContain('getAssetLogoUrl');
    expect(brandSource).not.toContain('cdn.jsdelivr.net');
    expect(brandSource).not.toContain('coingecko');
  });
});
