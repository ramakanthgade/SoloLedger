import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { produceSanitizedAppEvidence } from '../server/scripts/produce-sanitized-app-evidence.mjs';

test.describe.configure({ mode: 'serial' });

const generatedArtifacts = process.env.SOLOLEDGER_E2E_ARTIFACT_DIR
  ?? join(process.cwd(), 'test-results', 'generated-artifacts');
const generatedImages = join(generatedArtifacts, 'images');

async function screenshotDigest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function seedWorkspace(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__SOLOLEDGER_B6_SEED__ === 'function');
  await page.evaluate(() => window.__SOLOLEDGER_B6_SEED__!());
  await page.evaluate(() => {
    localStorage.setItem('sololedger_app_mode', 'local');
    localStorage.setItem('sololedger_app_mode_selected', '1');
    localStorage.setItem('sololedger_color_scheme', 'light');
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Dashboard', exact: true }).first()).toHaveAttribute('aria-selected', 'true');
}

async function persistedSafetyStates(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(async () => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open('sololedger_local');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction('transactions', 'readonly');
      const rows = transaction.objectStore('transactions').getAll();
      rows.onerror = () => reject(rows.error);
      rows.onsuccess = () => resolve(rows.result
        .filter((row) => String(row.id).startsWith('b6-safety-')).map((row) => row.safetyState));
    };
  }));
}

async function persistedSafetyLinksAreValid(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(async () => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('sololedger_local');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction(['transactions', 'safetyDecisions', 'providerEvidence'], 'readonly');
      const requests = ['transactions', 'safetyDecisions', 'providerEvidence'].map((store) =>
        transaction.objectStore(store).getAll());
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        const [transactions, decisions, evidence] = requests.map((row) => row.result);
        const subjects = new Set([
          ...transactions.map((row) => row.safetySubjectKey).filter(Boolean),
          ...evidence.map((row) => row.subjectKey).filter(Boolean)
        ]);
        resolve(decisions.every((decision) => subjects.has(decision.subjectKey) &&
          (decision.origin !== 'automatic' || decision.evidenceIds?.every((id: string) =>
            evidence.some((row) => row.id === id && row.subjectKey === decision.subjectKey)))));
      };
    };
  }));
}

async function persistedTransactionSafety(page: import('@playwright/test').Page, id: string) {
  return page.evaluate(async (transactionId) => new Promise<{ safetyState?: string; isSpam?: boolean } | undefined>((resolve, reject) => {
    const request = indexedDB.open('sololedger_local');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction('transactions', 'readonly');
      const row = transaction.objectStore('transactions').get(transactionId);
      row.onerror = () => reject(row.error);
      row.onsuccess = () => resolve(row.result && { safetyState: row.result.safetyState, isSpam: row.result.isSpam });
    };
  }), id);
}

async function assertCoreRenderedState(page: import('@playwright/test').Page) {
  await page.getByRole('tab', { name: 'Dashboard', exact: true }).first().click();
  await expect(page.getByTestId('dashboard-total-net-worth')).toContainText('₹1,72,38,558.14');
  await expect(page.getByTestId('dashboard-holdings')).toContainText('WBTC');
  await expect(page.getByTestId('dashboard-holdings')).toContainText('USDC');
  await expect(page.getByTestId('dashboard-holdings')).toContainText('Borrowed · Variable rate');
  await expect(page.getByTestId('dashboard-holdings')).toContainText('Borrowed · Stable rate');
  await page.getByRole('tab', { name: 'Transactions', exact: true }).first().click();
  await expect(page.locator('[data-transaction-id="exact-out"]')).toContainText(/internal/i);
  await expect(page.locator('[data-transaction-id="b6-classified"]')).toContainText(/Staking|reward/i);
}

function money(text: string): number {
  const normalized = text.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  const value = Number(normalized);
  if (!Number.isFinite(value)) throw new Error('rendered money was not numeric');
  return value;
}

test('manifest, service worker, duplicate ids, and explicit persisted theme contract', async ({ page }) => {
  await seedWorkspace(page);
  await expect(page.locator('#root')).not.toBeEmpty();
  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  expect(await manifestResponse.json()).toMatchObject({ short_name: 'SoloLedger', display: 'standalone' });
  await page.evaluate(() => navigator.serviceWorker?.ready);
  expect(await page.evaluate(() => navigator.serviceWorker?.controller != null)).toBe(true);
  expect(await (await page.request.get('/sw.js')).text()).not.toMatch(/vendor-ccxt-[^"']+\.js/);
  expect(await page.locator('[id]').evaluateAll((elements) => {
    const ids = elements.map((element) => element.id).filter(Boolean);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  })).toEqual([]);

  const toggle = page.getByRole('button', { name: 'Switch to dark theme' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('sololedger_color_scheme'))).toBe('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
});

test('seeded v16 state drives rendered Dashboard, Connections, Transactions, attestation, and durable offline reload', async ({ page, context }) => {
  await seedWorkspace(page);
  const dashboardTotal = page.getByTestId('dashboard-total-net-worth');
  await expect(dashboardTotal).toContainText('₹1,72,38,558.14');
  await expect(page.getByTestId('dashboard-holdings')).toContainText('WBTC');
  await expect(page.getByTestId('dashboard-holdings')).toContainText('USDC');
  await expect(page.getByTestId('dashboard-holdings')).toContainText(/Liabilit(?:y|ies)/);
  await expect(page.getByTestId('dashboard-holdings')).toContainText('1.4975');
  await expect(page.getByTestId('dashboard-holdings')).not.toContainText('spWBTC');
  await expect(page.getByTestId('dashboard-holdings')).not.toContainText('aEthWBTC');
  const allocation = page.getByTestId('dashboard-allocation');
  await expect(allocation).toContainText('WBTC');
  await expect(allocation).toContainText('USDC');
  await expect(allocation).toContainText('WETH');
  await expect(allocation).not.toContainText(/spWBTC|aEth|DebtUSDC/i);
  await mkdir(generatedImages, { recursive: true });
  const dashboardScreenshot = join(generatedImages, 'defi-dashboard-light.png');
  const allocationScreenshot = join(generatedImages, 'defi-allocation-light.png');
  await page.screenshot({ path: dashboardScreenshot, fullPage: true });
  await allocation.screenshot({ path: allocationScreenshot });
  const dashboardCapture = {
    dashboardNetWorth: money(await dashboardTotal.textContent() ?? ''),
    featureEnabled: true,
    shadowStatus: 'complete'
  };

  await page.getByRole('tab', { name: 'Connections', exact: true }).first().click();
  const walletCard = page.getByRole('button', { name: 'Open overall holdings for Diagnosed wallet' });
  await walletCard.focus();
  await walletCard.press('Enter');
  await expect(page.getByTestId('account-ownership')).toContainText(/Mine|Owned by me/);
  const connectionsTotal = page.getByTestId('detail-holdings-total');
  await expect(connectionsTotal).toContainText('₹1,72,38,558.14');
  await expect(connectionsTotal).toHaveAttribute('data-defi-feature-enabled', 'true');
  await expect(page.getByTestId('detail-holdings')).toContainText('Aave');
  await expect(page.getByTestId('detail-holdings')).toContainText('Spark');
  await expect(page.getByTestId('detail-holdings')).toContainText('Liability · stable');
  await expect(page.getByTestId('detail-holdings')).toContainText('Liability · variable');
  await expect(page.getByTestId('detail-holdings')).not.toContainText(/spWBTC|aEthWBTC/);
  const connectionsScreenshot = join(generatedImages, 'defi-connections-light.png');
  await page.screenshot({ path: connectionsScreenshot, fullPage: true });
  const screenshots = [
    { name: 'dashboard', sha256: await screenshotDigest(dashboardScreenshot) },
    { name: 'connections', sha256: await screenshotDigest(connectionsScreenshot) },
    { name: 'allocation', sha256: await screenshotDigest(allocationScreenshot) }
  ];
  const renderedCapture = {
    ...dashboardCapture,
    connectionsNetWorth: money(await connectionsTotal.textContent() ?? ''),
  };
  await page.getByTestId('detail-back').click();
  await expect(walletCard).toBeFocused();

  await page.getByRole('tab', { name: 'Transactions', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Transactions', exact: true })).toBeVisible();
  await expect(page.locator('[data-transaction-id="exact-out"]')).toContainText(/internal/i);
  await expect(page.locator('[data-transaction-id="suggested-out"]')).toContainText(/possible|suggest/i);
  await expect(page.locator('[data-transaction-id="b6-classified"]')).toContainText(/Staking|reward/i);
  await expect(page.locator('[data-transaction-id="b6-classified"]')).toContainText('Diagnosed wallet');

  const captureDirectory = generatedArtifacts;
  const capturePath = join(captureDirectory, 'defi-rollout-capture.json');
  const evidencePath = join(captureDirectory, 'defi-rollout-evidence.json');
  await writeFile(capturePath, JSON.stringify({
    captureVersion: 'b6-browser-capture-v2', captureMethod: 'playwright-rendered-ui',
    ...renderedCapture,
    targetUrl: await page.evaluate(() => location.href),
    buildSha: await page.locator('#root').getAttribute('data-build-sha'),
    authenticatedRunId: 'playwright-b6-run',
    screenshots,
    selectors: ['[data-testid="dashboard-total-net-worth"]', '[data-testid="detail-holdings-total"]']
  }));
  await produceSanitizedAppEvidence(capturePath, evidencePath, {
    targetUrl: 'http://127.0.0.1:4173', buildSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    runId: 'playwright-b6-run', signingKey: 'b6-test-signing-key-that-is-at-least-32-bytes'
  });
  expect(JSON.parse(await readFile(evidencePath, 'utf8'))).toMatchObject({
    evidenceVersion: 'b6-browser-evidence-v2', dashboardNetWorth: 17_238_558.14,
    connectionsNetWorth: 17_238_558.14, featureEnabled: true,
    targetUrl: 'http://127.0.0.1:4173/', buildSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    authenticatedRun: { method: 'ci-hmac', runId: 'playwright-b6-run' },
    screenshots: expect.arrayContaining(screenshots),
    attestation: { algorithm: 'hmac-sha256', digest: expect.stringMatching(/^[0-9a-f]{64}$/) }
  });

  // Exercise the real hide/restore UI and prove each decision survives reload.
  const classifiedRow = page.locator('[data-transaction-id="b6-classified"]');
  await classifiedRow.getByRole('button', { name: 'Edit transaction flags' }).click();
  await classifiedRow.getByRole('button', { name: 'Hide as spam' }).click();
  await expect(classifiedRow).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: 'Transactions', exact: true }).first().click();
  await page.getByRole('button', { name: /Spam \(/ }).click();
  const hiddenClassified = page.locator('[data-transaction-id="b6-classified"]');
  await expect(hiddenClassified).toBeVisible();
  await hiddenClassified.getByRole('button', { name: 'Edit transaction flags' }).click();
  await hiddenClassified.getByRole('button', { name: '↩ Restore visibility' })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => persistedTransactionSafety(page, 'b6-classified')).toEqual({
    safetyState: 'user_visible', isSpam: false
  });
  await page.reload();
  expect(await persistedSafetyStates(page)).toEqual(expect.arrayContaining([
    'trusted', 'high_confidence_spam', 'unverified', 'user_hidden', 'user_visible'
  ]));

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('tab', { name: 'Transactions', exact: true }).last()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  const undersized = await page.locator('button:visible, [role="button"]:visible, input:visible').evaluateAll((elements) =>
    elements.flatMap((element) => {
      const target = element instanceof HTMLInputElement
        ? element.closest('label') ?? element
        : element;
      const box = target.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44)
        ? [`${element.tagName}:${element.getAttribute('aria-label') ?? element.textContent?.trim()}:${box.width}x${box.height}`]
        : [];
    }));
  expect(undersized).toEqual([]);

  // A fresh page in the same installed-app context models standalone relaunch.
  await page.close();
  page = await context.newPage();
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker?.ready);
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => {
        localStorage.setItem('sololedger_color_scheme', value);
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await assertCoreRenderedState(page);
    }
    await page.getByRole('tab', { name: 'Connections', exact: true }).first().click();
    await page.getByRole('button', { name: 'Open overall holdings for Diagnosed wallet' }).click();
    await expect(page.getByTestId('account-ownership')).toContainText(/Mine|Owned by me/);
    expect(await persistedSafetyStates(page)).toEqual(expect.arrayContaining([
      'trusted', 'high_confidence_spam', 'unverified', 'user_hidden', 'user_visible'
    ]));
    expect(await persistedSafetyLinksAreValid(page)).toBe(true);
    await page.getByRole('tab', { name: 'Transactions', exact: true }).first().click();
    await expect(page.locator('[data-transaction-id="b6-safety-trusted"]')).toBeVisible();
    await expect(page.locator('[data-transaction-id="b6-safety-unverified"]')).toBeVisible();
    await expect(page.locator('[data-transaction-id="b6-safety-visible"]')).toBeVisible();
    await page.getByRole('button', { name: /Spam \(/ }).click();
    await expect(page.locator('[data-transaction-id="b6-safety-spam"]')).toContainText(/spam/i);
    await expect(page.locator('[data-transaction-id="b6-safety-hidden"]')).toContainText(/spam/i);
  } finally {
    await context.setOffline(false);
  }
});

test('coherent Dashboard periods publish ready and Transactions recomputes a linked category total', async ({ page }) => {
  await seedWorkspace(page);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.getByTestId('dashboard-total-net-worth')).toContainText('₹1,72,38,558.14');
  await expect(page.getByTestId('dashboard-nominal-range')).toHaveCount(1);
  await expect(page.getByTestId('dashboard-effective-cutoff')).toHaveCount(1);
  await expect(page.getByText('Sec. 115BBH tax')).toBeVisible();
  await expect(page.getByText('30%')).toBeVisible();
  await expect(page.getByText('4%')).toBeVisible();
  const controlsBox = await page.getByRole('radiogroup', { name: 'Dashboard period' }).boundingBox();
  const metadataBox = await page.getByTestId('dashboard-nominal-range').boundingBox();
  expect(controlsBox).not.toBeNull();
  expect(metadataBox).not.toBeNull();
  expect(Math.abs(controlsBox!.y - metadataBox!.y)).toBeLessThan(12);

  await page.getByRole('radio', { name: 'Custom range' }).click();
  await expect(page.getByRole('radio', { name: 'Custom range' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('radio', { name: 'This tax year' })).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Custom start date').fill('2026-04-01');
  await page.getByLabel('Custom end date').fill('2026-08-12');
  await page.getByRole('button', { name: 'Apply range' }).click();
  await expect(page.getByRole('radio', { name: 'Custom range' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.getByText('Estimated Tax · Custom range')).toBeVisible();

  await page.getByTestId('dashboard-hero').getByRole('button', { name: /^Income/ }).click();
  const summary = page.getByTestId('dashboard-filter-summary').first();
  await expect(summary).toContainText('Income:');
  const before = money(await summary.textContent() ?? '');
  expect(before).toBe(0);
  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('sololedger_local');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction('transactions', 'readwrite');
      const store = transaction.objectStore('transactions');
      const get = store.get('b6-classified');
      get.onerror = () => reject(get.error);
      get.onsuccess = () => store.put({ ...get.result, fiatCurrency: 'INR', fiatValue: 1_000 });
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
    };
  }));
  const category = page.locator('[data-transaction-id="b6-classified"]').getByRole('combobox', { name: 'Semantic category' });
  await category.selectOption({ label: 'Other income' });
  await expect.poll(async () => money(await summary.textContent() ?? '')).toBe(1_000);
});

test('known positive debt without a verified INR price keeps a numeric subtotal and disclosure', async ({ page }) => {
  await seedWorkspace(page);
  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('sololedger_local');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction('priceCache', 'readwrite');
      transaction.objectStore('priceCache').delete('spot:ctr:ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:INR');
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
    };
  }));
  await page.reload();
  await expect(page.getByTestId('dashboard-total-net-worth')).toContainText('₹94,48,000.00');
  await expect(page.getByTestId('dashboard-total-net-worth')).not.toContainText(/Incomplete|Unavailable/);
  await expect(page.getByTestId('dashboard-hero')).toContainText(/available ledger history.*eligible prices/i);
});

test('exchange auto-sync remains online-only and is never silently cached', async ({ page }) => {
  await seedWorkspace(page);
  await page.getByRole('tab', { name: 'Connections', exact: true }).first().click();
  await expect(page.getByText('Primary Binance')).toBeVisible();
  await expect(page.getByText(/Reconnect|reauthor/i).first()).toBeVisible();
  const worker = await page.request.get('/sw.js');
  expect(await worker.text()).not.toContain('vendor-ccxt-');
});
