#!/usr/bin/env node
/**
 * Approved read-only wallet/DeFi verifier. Output is deliberately aggregate:
 * never print credentials, wallet addresses, hashes, RPC/relay URLs or payloads.
 *
 * Required for a full rollout run:
 * MODE=production TARGET_URL=... PRODUCTION_RELAY_URL=... RELAY_AUTH_TOKEN=...
 * VERIFY_WALLET=0x... VERIFY_RESERVES=0x...,0x...
 * EXPECTED_RESERVE_VALUES='{"0x...":{"price":1,"liquid":1,"supplied":2,"debt":1,"netWorth":2}}'
 * EXPECTED_DEBT=... EXPECTED_NET_WORTH=... EXPECTED_LIQUID_ASSETS=...
 * APP_EVIDENCE_URL=...
 * Set VERIFY_MODE=smoke explicitly to allow Moralis/app-equality skips.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalTargetUrl } from './produce-sanitized-app-evidence.mjs';
const MODE = process.env.MODE === 'production' ? 'production' : 'local';
const VERIFY_MODE = process.env.VERIFY_MODE === 'smoke' ? 'smoke' : 'rollout';
const TARGET_URL = process.env.TARGET_URL ?? 'http://127.0.0.1:5173';
const TIMEOUT_MS = Math.min(30_000, Math.max(1_000, Number(process.env.VERIFY_TIMEOUT_MS) || 10_000));
const PAGE_BUDGET = 100;
const PROTOCOLS = [
  { dataProvider: '0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d' },
  { dataProvider: '0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3' },
  { dataProvider: '0xFc21d6d146E6086B8359705C8b28512a983db0cb' }
];
const SELECTORS = { userReserve: '0xbf92857c', decimals: '0x313ce567', balanceOf: '0x70a08231' };

class BlockedError extends Error {}
const canonicalAddress = (value) => /^0x[0-9a-f]{40}$/i.test(value ?? '');
const safeOrigin = (value) => { try { return new URL(value).origin; } catch { return '(invalid target)'; } };
const word = (value) => value.replace(/^0x/, '').padStart(64, '0');
const addressWord = (value) => word(value.toLowerCase().slice(2));
const asBigInt = (value) => { if (!/^0x[0-9a-f]+$/i.test(value ?? '')) throw new Error('invalid hexadecimal RPC result'); return BigInt(value); };
const decimal = (raw, decimals) => Number(raw) / 10 ** decimals;
const canonical = (value) => value.toLowerCase();
const expectedNumber = (name) => {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) throw new BlockedError(`${name} is required for diagnosed-wallet assertions`);
  return value;
};
const assertNear = (label, actual, expected) => {
  const tolerance = Math.max(0, Number(process.env.VERIFY_TOLERANCE) || 1);
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) throw new Error(`${label} assertion failed`);
};

async function boundedFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' }); }
  finally { clearTimeout(timer); }
}
async function jsonFetch(url, init, label) {
  const response = await boundedFetch(url, init);
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status})`);
  try { return await response.json(); } catch { throw new Error(`${label} returned malformed JSON`); }
}
async function verifyApp() {
  const response = await boundedFetch(TARGET_URL, { headers: { accept: 'text/html' } });
  const text = await response.text();
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html') || !/<div[^>]+id=["']root["']/i.test(text)) {
    throw new Error(`app probe failed (HTTP ${response.status})`);
  }
  return `app HTTP ${response.status}`;
}
async function rpc(method, params) {
  return relayRpc(method, params);
}
async function relayRpc(method, params) {
  if (!process.env.PRODUCTION_RELAY_URL || !process.env.RELAY_AUTH_TOKEN) {
    throw new BlockedError('production relay URL and authentication token are required for exhaustive history verification');
  }
  const url = new URL('/api/proxy/alchemy/eth-mainnet', process.env.PRODUCTION_RELAY_URL);
  const body = await jsonFetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RELAY_AUTH_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  }, 'authenticated relay');
  if (body?.error || body?.result == null) throw new Error('authenticated relay returned no result');
  return body.result;
}
async function exhaustDirection(wallet, direction) {
  let pageKey;
  const seen = new Set();
  let pages = 0;
  let transfers = 0;
  do {
    if (pages >= PAGE_BUDGET) throw new Error('history pagination exceeded the 100-page safety budget');
    const result = await relayRpc('alchemy_getAssetTransfers', [{
      [direction === 'outgoing' ? 'fromAddress' : 'toAddress']: wallet,
      category: ['external', 'erc20', 'erc721', 'erc1155'], withMetadata: true,
      excludeZeroValue: true, maxCount: '0x64', ...(pageKey ? { pageKey } : {})
    }]);
    if (!Array.isArray(result.transfers)) throw new Error('history pagination returned malformed transfers');
    transfers += result.transfers.length;
    pages += 1;
    const next = result.pageKey;
    if (next != null && (typeof next !== 'string' || !next || seen.has(next))) throw new Error('history pagination repeated or malformed a cursor');
    if (next) seen.add(next);
    pageKey = next;
  } while (pageKey);
  return { pages, transfers };
}
async function verifyExhaustiveHistory(wallet) {
  const outgoing = await exhaustDirection(wallet, 'outgoing');
  const incoming = await exhaustDirection(wallet, 'incoming');
  return `history exhausted 2 streams across ${outgoing.pages + incoming.pages} pages`;
}
async function ethCall(to, data, block) { return rpc('eth_call', [{ to, data }, block]); }
async function tokenDecimals(reserve, block) {
  const result = await ethCall(reserve, SELECTORS.decimals, block);
  const value = Number(asBigInt(result));
  if (!Number.isInteger(value) || value < 0 || value > 36) throw new Error('reserve decimals were invalid');
  return value;
}
async function directProtocolTotals(wallet, reserves, block) {
  const byReserve = new Map();
  for (const reserve of reserves) {
    const decimals = await tokenDecimals(reserve, block);
    let supplied = 0;
    let debt = 0;
    for (const protocol of PROTOCOLS) {
      const result = await ethCall(protocol.dataProvider, `${SELECTORS.userReserve}${addressWord(reserve)}${addressWord(wallet)}`, block);
      const clean = result.replace(/^0x/, '');
      if (clean.length < 64 * 3 || !/^[0-9a-f]+$/i.test(clean)) throw new Error('protocol position call returned malformed data');
      supplied += decimal(BigInt(`0x${clean.slice(0, 64)}`), decimals);
      debt += decimal(BigInt(`0x${clean.slice(64, 128)}`) + BigInt(`0x${clean.slice(128, 192)}`), decimals);
    }
    byReserve.set(canonical(reserve), { decimals, supplied, debt });
  }
  return byReserve;
}
async function liquidAssets(wallet, reserves, block) {
  const byReserve = new Map();
  for (const reserve of reserves) {
    const decimals = await tokenDecimals(reserve, block);
    const raw = await ethCall(reserve, `${SELECTORS.balanceOf}${addressWord(wallet)}`, block);
    byReserve.set(canonical(reserve), decimal(asBigInt(raw), decimals));
  }
  return byReserve;
}
function expectedReserveValues(reserves) {
  let parsed;
  try { parsed = JSON.parse(process.env.EXPECTED_RESERVE_VALUES ?? ''); }
  catch { throw new BlockedError('EXPECTED_RESERVE_VALUES must be valid per-reserve JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BlockedError('EXPECTED_RESERVE_VALUES is required per canonical reserve');
  const output = new Map();
  for (const reserve of reserves) {
    const row = parsed[canonical(reserve)] ?? parsed[reserve];
    const values = row && ['price', 'liquid', 'supplied', 'debt', 'netWorth'].map((key) => Number(row[key]));
    if (!values || values.some((value) => !Number.isFinite(value))) throw new BlockedError('EXPECTED_RESERVE_VALUES must include price and expected values for every reserve');
    output.set(canonical(reserve), { price: values[0], liquid: values[1], supplied: values[2], debt: values[3], netWorth: values[4] });
  }
  return output;
}
async function verifyDirectPositions(wallet, reserves) {
  if (!canonicalAddress(wallet) || reserves.length === 0 || !reserves.every(canonicalAddress)) {
    throw new BlockedError('VERIFY_WALLET and canonical VERIFY_RESERVES are required');
  }
  if (await rpc('eth_chainId', []) !== '0x1') throw new Error('direct verifier requires Ethereum mainnet');
  const block = await rpc('eth_blockNumber', []);
  const quantities = await directProtocolTotals(wallet, reserves, block);
  const liquidQuantities = await liquidAssets(wallet, reserves, block);
  const expected = expectedReserveValues(reserves);
  const values = new Map();
  for (const reserve of reserves.map(canonical)) {
    const quantity = quantities.get(reserve);
    const expectedRow = expected.get(reserve);
    const liquid = (liquidQuantities.get(reserve) ?? 0) * expectedRow.price;
    const supplied = quantity.supplied * expectedRow.price;
    const debt = quantity.debt * expectedRow.price;
    const netWorth = liquid + supplied - debt;
    assertNear('reserve liquid value', liquid, expectedRow.liquid);
    assertNear('reserve supplied value', supplied, expectedRow.supplied);
    assertNear('reserve debt value', debt, expectedRow.debt);
    assertNear('reserve net-worth value', netWorth, expectedRow.netWorth);
    values.set(reserve, { liquid, supplied, debt, netWorth });
  }
  const totals = [...values.values()].reduce((sum, row) => ({
    liquid: sum.liquid + row.liquid, supplied: sum.supplied + row.supplied,
    debt: sum.debt + row.debt, netWorth: sum.netWorth + row.netWorth
  }), { liquid: 0, supplied: 0, debt: 0, netWorth: 0 });
  assertNear('debt value', totals.debt, expectedNumber('EXPECTED_DEBT'));
  assertNear('liquid asset value', totals.liquid, expectedNumber('EXPECTED_LIQUID_ASSETS'));
  assertNear('net-worth value', totals.netWorth, expectedNumber('EXPECTED_NET_WORTH'));
  return { message: `per-reserve Aave/Spark value assertions passed at one block`, values, block };
}
async function verifyMoralis(wallet, directValues) {
  if (VERIFY_MODE === 'smoke' && process.env.VERIFY_MORALIS !== 'true') {
    return 'SKIP Moralis comparison (explicit smoke mode)';
  }
  if (!process.env.PRODUCTION_RELAY_URL || !process.env.RELAY_AUTH_TOKEN) {
    throw new BlockedError('production relay URL and authentication token are required for Moralis comparison');
  }
  const url = new URL(`/api/proxy/moralis/api/v2.2/wallets/${wallet}/defi/positions`, process.env.PRODUCTION_RELAY_URL);
  url.searchParams.set('chain', 'eth');
  const body = await jsonFetch(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${process.env.RELAY_AUTH_TOKEN}` }
  }, 'authenticated Moralis relay');
  const rows = Array.isArray(body?.result) ? body.result : Array.isArray(body) ? body : null;
  if (!rows) throw new Error('Moralis comparison returned malformed positions');
  const moralisDebt = new Map();
  for (const token of rows.flatMap((position) => Array.isArray(position?.tokens) ? position.tokens : [])) {
    if (!/debt|borrow/i.test(String(token?.token_type ?? token?.type ?? ''))) continue;
    const reserve = String(token?.contract_address ?? token?.underlying_token_address ?? '').toLowerCase();
    if (!canonicalAddress(reserve) || !directValues.has(reserve)) continue;
    moralisDebt.set(reserve, (moralisDebt.get(reserve) ?? 0) + Math.abs(Number(token?.balance_usd ?? token?.usd_value ?? token?.value_usd ?? 0) || 0));
  }
  for (const [reserve, direct] of directValues) assertNear('Moralis per-reserve debt comparison', moralisDebt.get(reserve) ?? 0, direct.debt);
  return 'PASS Moralis per-reserve debt comparison';
}
export function verifyAttestedUiEvidence(body, provenance) {
  if (body?.evidenceVersion !== 'b6-browser-evidence-v2' ||
    body?.captureVersion !== 'b6-browser-capture-v2' ||
    body?.captureMethod !== 'playwright-rendered-ui' || body?.featureEnabled !== true ||
    !Array.isArray(body?.screenshots) || body.screenshots.length !== 3 ||
    body.screenshots.some((item) => !['allocation', 'connections', 'dashboard'].includes(item?.name) || !/^[0-9a-f]{64}$/.test(item?.sha256 ?? '')) ||
    body?.attestation?.algorithm !== 'hmac-sha256' || !/^[0-9a-f]{64}$/.test(body?.attestation?.digest ?? '')) {
    throw new Error('attested browser UI evidence is required for rollout');
  }
  const signingKey = provenance.signingKey ?? '';
  const expectedBuildSha = (provenance.buildSha ?? '').toLowerCase();
  const expectedRunId = provenance.runId ?? '';
  if (signingKey.length < 32 || !/^[0-9a-f]{7,64}$/.test(expectedBuildSha) || !expectedRunId) {
    throw new BlockedError('signed browser provenance inputs are required in full rollout mode');
  }
  if (body.targetUrl !== canonicalTargetUrl(provenance.targetUrl) || body.buildSha !== expectedBuildSha ||
    body?.authenticatedRun?.method !== 'ci-hmac' || body?.authenticatedRun?.runId !== expectedRunId) {
    throw new Error('browser evidence target URL, build, or authenticated run provenance differed');
  }
  const attested = {
    evidenceVersion: body.evidenceVersion, captureVersion: body.captureVersion,
    captureMethod: body.captureMethod, dashboardNetWorth: Number(body.dashboardNetWorth),
    connectionsNetWorth: Number(body.connectionsNetWorth), featureEnabled: body.featureEnabled,
    shadowStatus: body.shadowStatus, targetUrl: body.targetUrl, buildSha: body.buildSha,
    authenticatedRun: body.authenticatedRun,
    screenshots: [...body.screenshots].map((item) => ({ name: item.name, sha256: item.sha256 })).sort((left, right) => left.name.localeCompare(right.name)),
    selectors: Array.isArray(body.selectors) ? [...body.selectors].sort() : []
  };
  const actualDigest = Buffer.from(body.attestation.digest, 'hex');
  const expectedDigest = createHmac('sha256', signingKey).update(JSON.stringify(attested)).digest();
  if (actualDigest.length !== expectedDigest.length || !timingSafeEqual(actualDigest, expectedDigest)) {
    throw new Error('browser evidence attestation verification failed');
  }
}
async function verifyUiEquality() {
  if (!process.env.APP_EVIDENCE_URL) {
    if (VERIFY_MODE === 'rollout') throw new BlockedError('APP_EVIDENCE_URL is required in full rollout mode');
    return 'SKIP Dashboard/Connections equality (explicit smoke mode)';
  }
  const headers = { accept: 'application/json', ...(process.env.APP_EVIDENCE_TOKEN ? { authorization: `Bearer ${process.env.APP_EVIDENCE_TOKEN}` } : {}) };
  const body = await jsonFetch(process.env.APP_EVIDENCE_URL, { headers }, 'app evidence');
  const dashboard = Number(body?.dashboardNetWorth);
  const connections = Number(body?.connectionsNetWorth);
  if (!Number.isFinite(dashboard) || dashboard !== connections) throw new Error('Dashboard/Connections deterministic totals differed');
  if (VERIFY_MODE === 'rollout') {
    verifyAttestedUiEvidence(body, {
      targetUrl: TARGET_URL, buildSha: process.env.EXPECTED_BUILD_SHA,
      runId: process.env.AUTHENTICATED_BROWSER_RUN_ID, signingKey: process.env.APP_EVIDENCE_SIGNING_KEY
    });
    const expected = expectedNumber('EXPECTED_NET_WORTH');
    assertNear('Dashboard rendered net worth', dashboard, expected);
    assertNear('Connections rendered net worth', connections, expected);
  }
  return 'PASS attested Dashboard/Connections rendered equality';
}

export async function main() {
  console.log(`Wallet DeFi verification: mode=${MODE}, verification=${VERIFY_MODE}, target=${safeOrigin(TARGET_URL)}`);
  console.log(`PASS ${await verifyApp()}`);
  const wallet = process.env.VERIFY_WALLET ?? '';
  if (VERIFY_MODE === 'smoke' && MODE !== 'production' && !process.env.PRODUCTION_RELAY_URL) {
    console.log('SKIP diagnosed-wallet checks (local app-only mode)');
    return;
  }
  console.log(`PASS ${await verifyExhaustiveHistory(wallet)}`);
  const reserves = (process.env.VERIFY_RESERVES ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const direct = await verifyDirectPositions(wallet, reserves);
  console.log(`PASS ${direct.message}`);
  console.log(await verifyMoralis(wallet, direct.values));
  console.log(await verifyUiEquality());
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const blocked = error instanceof BlockedError;
    console.error(`${blocked ? 'BLOCKED' : 'FAIL'} ${error instanceof Error ? error.message : 'verification failed'}`);
    process.exitCode = blocked ? 2 : 1;
  });
}
