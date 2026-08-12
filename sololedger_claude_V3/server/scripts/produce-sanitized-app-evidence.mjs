#!/usr/bin/env node
/** Publish only attested aggregate evidence captured from the rendered app. */
import { createHmac, randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_EVIDENCE_VERSION = 'b6-browser-evidence-v2';
export const APP_CAPTURE_VERSION = 'b6-browser-capture-v2';

export function canonicalTargetUrl(value) {
  try {
    const parsed = new URL(value);
    const collapsed = parsed.pathname.replace(/\/{2,}/g, '/');
    const pathname = collapsed === '/' ? '/' : collapsed.replace(/\/+$/, '');
    return `${parsed.origin}${pathname}`;
  } catch { throw new Error('invalid browser capture target'); }
}

export function sanitizedAppEvidence(value, provenance = {}) {
  const dashboardNetWorth = Number(value?.dashboardNetWorth);
  const connectionsNetWorth = Number(value?.connectionsNetWorth);
  const screenshots = Array.isArray(value?.screenshots) ? value.screenshots.map((item) => ({
    name: String(item?.name ?? ''), sha256: String(item?.sha256 ?? '').toLowerCase()
  })).sort((left, right) => left.name.localeCompare(right.name)) : [];
  const requiredScreenshots = ['allocation', 'connections', 'dashboard'];
  if (!Number.isFinite(dashboardNetWorth) || !Number.isFinite(connectionsNetWorth) ||
    value?.captureVersion !== APP_CAPTURE_VERSION || value?.captureMethod !== 'playwright-rendered-ui' ||
    value?.featureEnabled !== true || typeof value?.shadowStatus !== 'string' || !value.shadowStatus ||
    screenshots.length !== requiredScreenshots.length ||
    screenshots.some((item, index) => item.name !== requiredScreenshots[index] || !/^[0-9a-f]{64}$/.test(item.sha256)) ||
    !Array.isArray(value?.selectors) || !value.selectors.includes('[data-testid="dashboard-total-net-worth"]') ||
    !value.selectors.includes('[data-testid="detail-holdings-total"]')) {
    throw new Error('invalid browser capture');
  }
  const targetUrl = canonicalTargetUrl(provenance.targetUrl);
  const browserTargetUrl = canonicalTargetUrl(value?.targetUrl);
  const buildSha = String(provenance.buildSha ?? '');
  const runId = String(provenance.runId ?? '');
  const signingKey = String(provenance.signingKey ?? '');
  if (browserTargetUrl !== targetUrl || value?.buildSha !== buildSha || !/^[0-9a-f]{7,64}$/i.test(buildSha) ||
    !runId || value?.authenticatedRunId !== runId || signingKey.length < 32) {
    throw new Error('browser capture provenance did not match the authenticated run');
  }
  const attested = {
    evidenceVersion: APP_EVIDENCE_VERSION,
    captureVersion: APP_CAPTURE_VERSION,
    captureMethod: 'playwright-rendered-ui',
    dashboardNetWorth,
    connectionsNetWorth,
    featureEnabled: true,
    shadowStatus: value.shadowStatus,
    targetUrl: browserTargetUrl,
    buildSha: buildSha.toLowerCase(),
    authenticatedRun: { method: 'ci-hmac', runId },
    screenshots,
    selectors: [...value.selectors].sort()
  };
  return {
    ...attested,
    attestation: {
      algorithm: 'hmac-sha256',
      digest: createHmac('sha256', signingKey).update(JSON.stringify(attested)).digest('hex')
    }
  };
}

export async function produceSanitizedAppEvidence(inputPath, outputPath, provenance = {
  targetUrl: process.env.TARGET_URL,
  buildSha: process.env.EXPECTED_BUILD_SHA,
  runId: process.env.AUTHENTICATED_BROWSER_RUN_ID,
  signingKey: process.env.APP_EVIDENCE_SIGNING_KEY
}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch {
    throw new Error('app evidence input could not be read');
  }
  const sanitized = sanitizedAppEvidence(parsed, provenance);
  const temporary = resolve(dirname(outputPath), `.${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, outputPath);
    await chmod(outputPath, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return sanitized;
}

async function main() {
  const inputIndex = process.argv.indexOf('--input');
  const outputIndex = process.argv.indexOf('--output');
  if (inputIndex < 0 || outputIndex < 0 || !process.argv[inputIndex + 1] || !process.argv[outputIndex + 1]) {
    throw new Error('invalid arguments');
  }
  await produceSanitizedAppEvidence(resolve(process.argv[inputIndex + 1]), resolve(process.argv[outputIndex + 1]));
  console.log('PASS attested browser app evidence written');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => {
    console.error('FAIL app evidence production failed');
    process.exitCode = 1;
  });
}
