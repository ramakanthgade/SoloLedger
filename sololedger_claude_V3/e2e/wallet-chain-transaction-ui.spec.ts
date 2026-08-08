import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ARTIFACTS = join(
  process.env.SOLOLEDGER_E2E_ARTIFACT_DIR ?? join(process.cwd(), 'test-results', 'generated-artifacts'),
  'images'
);
const WIDTHS = [1440, 1024, 390] as const;
const COLOR_SCHEMES = ['light', 'dark'] as const;

async function seed(page: Page, colorScheme: typeof COLOR_SCHEMES[number] = 'light') {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__SOLOLEDGER_B6_SEED__ === 'function');
  await page.evaluate(() => window.__SOLOLEDGER_B6_SEED__!());
  await page.evaluate((scheme) => {
    localStorage.setItem('sololedger_app_mode', 'local');
    localStorage.setItem('sololedger_app_mode_selected', '1');
    localStorage.setItem('sololedger_color_scheme', scheme);
  }, colorScheme);
  await page.reload();
}

test.beforeAll(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
});

test('wallet disclosure and economic transaction tracks remain responsive at target widths', async ({ page }) => {
  for (const colorScheme of COLOR_SCHEMES) {
    await seed(page, colorScheme);
    await page.getByRole('tab', { name: 'Connections', exact: true }).first().click();
    const wallet = page.getByTestId(/connection-card-wallet:/).filter({ hasText: 'Diagnosed wallet' });
    const disclosure = wallet.locator('button[aria-expanded]').first();
    await expect(wallet.getByTestId('wallet-summary-transaction-count')).toContainText('909 transactions');
    await disclosure.click();
    await expect(wallet.getByTestId('wallet-chain-row')).toHaveCount(3);
    await expect(wallet).toContainText('Ethereum');
    await expect(wallet).toContainText('Polygon');
    await expect(wallet).toContainText('Optimism');
    await expect(wallet).toContainText('Synced 2h ago');
    await expect(wallet).toContainText('Needs attention');
    await expect(wallet).toContainText('RPC rate limit');
    const chainCounts = await wallet.getByTestId('wallet-chain-activity').locator('strong').allTextContents();
    expect(chainCounts.reduce((sum, value) => sum + Number(value.replaceAll(',', '')), 0)).toBe(909);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(wallet).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      const controls = await wallet.locator('button:visible').evaluateAll((buttons) => buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { label: button.getAttribute('aria-label') ?? button.textContent?.trim(), width: box.width, height: box.height };
      }));
      expect(controls.filter((control) => control.width > 0 && control.height > 0 &&
        (control.width < 44 || control.height < 44))).toEqual([]);
      if (width >= 1024) {
        const columns = await wallet.getByTestId('wallet-chain-row').first().evaluate((row) =>
          getComputedStyle(row).gridTemplateColumns.split(' ').length);
        expect(columns).toBe(4);
      } else {
        const chainRow = wallet.getByTestId('wallet-chain-row').first();
        const semanticOrder = await chainRow.evaluate((row) => ({
          activity: row.textContent?.indexOf('Activity') ?? -1,
          value: row.textContent?.indexOf('Current value') ?? -1,
          sync: row.textContent?.indexOf('Synced') ?? -1
        }));
        expect(semanticOrder.activity).toBeLessThan(semanticOrder.value);
        expect(semanticOrder.value).toBeLessThan(semanticOrder.sync);
        const activity = await chainRow.getByTestId('wallet-chain-activity').boundingBox();
        const value = await chainRow.getByTestId('wallet-chain-value').boundingBox();
        const sync = await chainRow.getByTestId('wallet-chain-sync').boundingBox();
        expect(activity && value && sync && activity.x < value.x && sync.y > activity.y).toBeTruthy();
      }
      if (width === 390) await wallet.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${ARTIFACTS}/connections-wallet-${width}-${colorScheme}.png`,
        fullPage: width !== 390
      });
    }

    await page.getByRole('tab', { name: 'Transactions', exact: true }).first().click();
    const transaction = page.locator('[data-transaction-id="b6-classified"]');
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(transaction).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      if (width >= 1024) {
        const layout = await transaction.locator(':scope > div').first().evaluate((row) => ({
          display: getComputedStyle(row).display,
          columns: getComputedStyle(row).gridTemplateColumns.split(' ').length
        }));
        expect(layout).toEqual({ display: 'grid', columns: 5 });
        const flow = await transaction.getByTestId('tx-flow').boundingBox();
        const source = await transaction.getByTestId('tx-source-account').boundingBox();
        expect(flow && source && flow.x < source.x && flow.width > source.width).toBeTruthy();
      }
      if (width === 390) await transaction.scrollIntoViewIfNeeded();
      if (width === 390) {
        await transaction.getByTestId('tx-disclosure').click();
        const details = transaction.getByTestId('tx-details');
        await expect(details).toBeVisible();
        const assertNoExpandedOverflow = async () => {
          expect(await page.locator('main').evaluate((main) => main.scrollWidth === main.clientWidth)).toBe(true);
          expect(await details.evaluate((panel) => panel.scrollWidth === panel.clientWidth)).toBe(true);
        };
        await assertNoExpandedOverflow();
        await details.getByRole('tab', { name: 'Ledger' }).click();
        await assertNoExpandedOverflow();
        const ledgerPanel = details.locator('#transaction-panel-ledger');
        const mobilePostings = details.getByTestId('ledger-mobile-postings');
        await expect(mobilePostings.getByTestId('ledger-mobile-posting')).toHaveCount(1);
        await expect(details.getByRole('table')).toBeHidden();
        const labels = mobilePostings.getByTestId('ledger-mobile-label');
        await expect(labels).toHaveText(['Posting', 'Asset / ledger', 'Signed change', 'Running balance']);
        const overflowedDescendants = await ledgerPanel.locator('*:visible').evaluateAll((elements) => elements
          .filter((element) => element.scrollWidth > element.clientWidth)
          .map((element) => ({ tag: element.tagName, text: element.textContent?.trim(), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })));
        expect(overflowedDescendants).toEqual([]);
        const labelBounds = await labels.evaluateAll((elements) => elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { text: element.textContent?.trim(), left: rect.left, right: rect.right, width: rect.width };
        }));
        expect(labelBounds.every(({ left, right, width }) => left >= 0 && right <= 390 && width > 0)).toBe(true);
        await expect(mobilePostings).not.toContainText('moralis:event:ethereum:erc20:staking-reward');
        await ledgerPanel.screenshot({
          path: `${ARTIFACTS}/transactions-ledger-mobile-390-${colorScheme}.png`,
        });
        await details.getByRole('tab', { name: 'Cost Analysis' }).click();
        await assertNoExpandedOverflow();
        await details.getByRole('tab', { name: 'Details' }).click();
        await assertNoExpandedOverflow();
      }
      await page.screenshot({
        path: `${ARTIFACTS}/transactions-economic-row-${width}-${colorScheme}.png`,
        fullPage: width !== 390
      });
    }
  }
});

test('canonical wallet rename reaches cards, transaction source/endpoints and filters immediately and after reload', async ({ page }) => {
  await seed(page);
  await page.getByRole('tab', { name: 'Transactions', exact: true }).first().click();
  const walletFilter = page.getByLabel('Wallet filter');
  await expect(walletFilter.locator('option')).toHaveCount(3);
  await expect(walletFilter.locator('option', { hasText: 'Diagnosed wallet' })).toHaveCount(1);
  const sourceFilter = page.getByLabel('Source filter');
  await expect(sourceFilter.locator('option', { hasText: 'Diagnosed wallet · Ethereum' })).toHaveCount(1);
  await expect(sourceFilter.locator('option', { hasText: 'Diagnosed wallet · Polygon' })).toHaveCount(1);
  const durableWalletId = await walletFilter.locator('option', { hasText: 'Diagnosed wallet' }).getAttribute('value');
  expect(durableWalletId).toBeTruthy();
  await walletFilter.selectOption(durableWalletId!);
  await expect(walletFilter).toHaveValue(durableWalletId!);

  await page.getByRole('tab', { name: 'Connections', exact: true }).first().click();
  await page.getByRole('button', { name: 'Diagnosed wallet actions' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const nickname = page.getByLabel('Wallet nickname');
  await nickname.fill('Treasury vault');
  await page.getByLabel('Save nickname').click();
  await expect(page.getByText('Treasury vault', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Transactions', exact: true }).first().click();
  await expect(page.getByLabel('Wallet filter')).toHaveValue(durableWalletId!);
  const row = page.locator('[data-transaction-id="b6-classified"]');
  await expect(row).toContainText('Treasury vault');
  await expect(page.getByLabel('Source filter')).toContainText('Treasury vault');
  await row.getByTestId('tx-disclosure').click();
  await expect(row).toContainText('Treasury vault');

  await page.reload();
  await page.getByRole('tab', { name: 'Transactions', exact: true }).first().click();
  await expect(page.getByLabel('Wallet filter')).toHaveValue(durableWalletId!);
  await expect(page.locator('[data-transaction-id="b6-classified"]')).toContainText('Treasury vault');
  await expect(page.getByLabel('Source filter')).toContainText('Treasury vault');
  await page.getByRole('tab', { name: 'Connections', exact: true }).first().click();
  await expect(page.getByText('Treasury vault', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Treasury vault actions' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Wallet nickname').fill('');
  await page.getByLabel('Save nickname').click();
  const clearedFallback = 'MetaMask · 0x1111…1111';
  await expect(page.getByText(clearedFallback, { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Transactions', exact: true }).first().click();
  await expect(page.getByLabel('Wallet filter').locator('option', { hasText: clearedFallback })).toHaveCount(1);
  const clearedRow = page.locator('[data-transaction-id="b6-classified"]');
  await expect(clearedRow.getByTestId('tx-source-account')).toContainText(clearedFallback);
  if (await clearedRow.getByTestId('tx-disclosure').getAttribute('aria-expanded') !== 'true') {
    await clearedRow.getByTestId('tx-disclosure').click();
  }
  await expect(clearedRow.getByTestId('tx-details')).toContainText(clearedFallback);

  await page.reload();
  await page.getByRole('tab', { name: 'Transactions', exact: true }).first().click();
  await expect(page.getByLabel('Wallet filter').locator('option', { hasText: clearedFallback })).toHaveCount(1);
  const reloadedRow = page.locator('[data-transaction-id="b6-classified"]');
  await expect(reloadedRow.getByTestId('tx-source-account')).toContainText(clearedFallback);
  if (await reloadedRow.getByTestId('tx-disclosure').getAttribute('aria-expanded') !== 'true') {
    await reloadedRow.getByTestId('tx-disclosure').click();
  }
  await expect(reloadedRow.getByTestId('tx-details')).toContainText(clearedFallback);
  await page.getByRole('tab', { name: 'Connections', exact: true }).first().click();
  await expect(page.getByText(clearedFallback, { exact: true })).toBeVisible();
});
