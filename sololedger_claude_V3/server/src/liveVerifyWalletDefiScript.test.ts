import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizedAppEvidence } from '../scripts/produce-sanitized-app-evidence.mjs';
import { verifyAttestedUiEvidence } from '../scripts/live-verify-wallet-defi.mjs';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

function runScript(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/live-verify-wallet-defi.mjs'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, ...env }
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('live wallet DeFi verifier', () => {
  const provenance = {
    targetUrl: 'https://app.example.test/SoloLedger/?query=ignored#fragment', buildSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    runId: 'authenticated-run-1', signingKey: 'test-signing-key-that-is-at-least-32-bytes'
  };
  const evidence = () => sanitizedAppEvidence({
    captureVersion: 'b6-browser-capture-v2', captureMethod: 'playwright-rendered-ui',
    dashboardNetWorth: 121_071, connectionsNetWorth: 121_071, featureEnabled: true,
    shadowStatus: 'complete', targetUrl: 'https://app.example.test/SoloLedger/', buildSha: provenance.buildSha,
    authenticatedRunId: provenance.runId,
    selectors: ['[data-testid="detail-holdings-total"]', '[data-testid="net-worth-value"]']
  }, provenance);

  it('recomputes the signed attestation and binds target origin, build SHA, and authenticated run', () => {
    expect(() => verifyAttestedUiEvidence(evidence(), provenance)).not.toThrow();
    expect(() => verifyAttestedUiEvidence({ ...evidence(), dashboardNetWorth: 1 }, provenance))
      .toThrow('attestation verification failed');
    expect(() => verifyAttestedUiEvidence(evidence(), { ...provenance, targetUrl: 'https://other.example.test' }))
      .toThrow('target URL, build, or authenticated run');
    expect(() => verifyAttestedUiEvidence(evidence(), { ...provenance, targetUrl: 'https://app.example.test/Other/' }))
      .toThrow('target URL, build, or authenticated run');
    expect(() => verifyAttestedUiEvidence(evidence(), { ...provenance, buildSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }))
      .toThrow('target URL, build, or authenticated run');
    expect(() => verifyAttestedUiEvidence(evidence(), { ...provenance, runId: 'other-run' }))
      .toThrow('target URL, build, or authenticated run');
  });

  it('supports a bounded local app probe and never logs configured secrets', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><div id="root"></div>');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const secret = 'never-print-this-rpc-secret';
    const result = await runScript({
      TARGET_URL: `http://127.0.0.1:${address.port}/?token=${secret}`,
      VERIFY_MODE: 'smoke',
      SL_TOKEN: secret,
      RPC_URL: '',
      PRODUCTION_RELAY_URL: '',
      VERIFY_TIMEOUT_MS: '2000'
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain('PASS app HTTP 200');
    expect(result.output).toContain('SKIP diagnosed-wallet checks (local app-only mode)');
    expect(result.output).not.toContain(secret);
  });

  it('contains the approved bounded relay, per-reserve same-block valuation, assertion, and UI-equality checks', async () => {
    const source = await readFile(new URL('../scripts/live-verify-wallet-defi.mjs', import.meta.url), 'utf8');
    expect(source).toContain("authorization: `Bearer ${process.env.RELAY_AUTH_TOKEN}`");
    expect(source).toContain("relayRpc('alchemy_getAssetTransfers'");
    expect(source).toContain('PAGE_BUDGET = 100');
    expect(source).toContain("const block = await rpc('eth_blockNumber', [])");
    expect(source).toContain('return relayRpc(method, params)');
    expect(source).not.toContain('process.env.RPC_URL');
    expect(source).toContain("userReserve: '0xbf92857c'");
    expect(source).toContain('directProtocolTotals(wallet, reserves, block)');
    expect(source).toContain('EXPECTED_RESERVE_VALUES');
    expect(source).toContain("values.set(reserve, { liquid, supplied, debt, netWorth })");
    expect(source).toContain('Moralis per-reserve debt comparison');
    expect(source).toContain('/api/proxy/moralis/api/v2.2/wallets/${wallet}/defi/positions');
    expect(source).toContain("authorization: `Bearer ${process.env.RELAY_AUTH_TOKEN}`");
    expect(source).not.toContain('MORALIS_API_KEY');
    expect(source).not.toContain('X-API-Key');
    expect(source).toContain("expectedNumber('EXPECTED_DEBT')");
    expect(source).toContain("expectedNumber('EXPECTED_NET_WORTH')");
    expect(source).toContain('Moralis per-reserve debt comparison');
    expect(source).toContain('Dashboard/Connections deterministic totals differed');
    expect(source).toContain("body?.captureMethod !== 'playwright-rendered-ui'");
    expect(source).toContain('body?.featureEnabled !== true');
    expect(source).toContain("createHmac('sha256', signingKey)");
    expect(source).toContain('timingSafeEqual(actualDigest, expectedDigest)');
    expect(source).toContain("assertNear('Dashboard rendered net worth', dashboard, expected)");
    expect(source).toContain("assertNear('Connections rendered net worth', connections, expected)");
    expect(source).not.toMatch(/console\.(?:log|error)\([^\n]*(?:RPC_URL|RELAY_AUTH_TOKEN|VERIFY_WALLET)/);
  });

  it('requires Moralis and deterministic UI evidence in rollout mode and only skips in explicit smoke mode', async () => {
    const source = await readFile(new URL('../scripts/live-verify-wallet-defi.mjs', import.meta.url), 'utf8');
    expect(source).toContain("process.env.VERIFY_MODE === 'smoke' ? 'smoke' : 'rollout'");
    expect(source).toContain("VERIFY_MODE === 'smoke' && process.env.VERIFY_MORALIS !== 'true'");
    expect(source).toContain("throw new BlockedError('APP_EVIDENCE_URL is required in full rollout mode')");
    expect(source).toContain('SKIP Moralis comparison (explicit smoke mode)');
    expect(source).toContain('SKIP Dashboard/Connections equality (explicit smoke mode)');
  });

  it('uses the deployed authenticated Moralis proxy route rather than a direct provider key', async () => {
    const [script, proxy] = await Promise.all([
      readFile(new URL('../scripts/live-verify-wallet-defi.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./routes/proxy.ts', import.meta.url), 'utf8')
    ]);
    expect(proxy).toContain("proxyRouter.all('/moralis/*'");
    expect(proxy).toContain("resolveApiKey('moralisApiKey')");
    expect(script).toContain('/api/proxy/moralis/api/v2.2/wallets/${wallet}/defi/positions');
    expect(script).not.toContain('deep-index.moralis.io');
  });

  it('blocks default rollout mode without relay credentials instead of app-only success', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><div id="root"></div>');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const result = await runScript({
      MODE: '', VERIFY_MODE: '', TARGET_URL: `http://127.0.0.1:${address.port}`,
      PRODUCTION_RELAY_URL: '', RELAY_AUTH_TOKEN: ''
    });
    expect(result.code).toBe(2);
    expect(result.output).toContain('verification=rollout');
    expect(result.output).toContain('BLOCKED production relay URL and authentication token are required');
    expect(result.output).not.toContain('SKIP diagnosed-wallet checks');
  });

  it('blocks a production run clearly without optional relay authentication and redacts identifiers', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><div id="root"></div>');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const wallet = `0x${'1'.repeat(40)}`;
    const result = await runScript({
      MODE: 'production', TARGET_URL: `http://127.0.0.1:${address.port}`,
      VERIFY_WALLET: wallet, PRODUCTION_RELAY_URL: '', RELAY_AUTH_TOKEN: '', RPC_URL: ''
    });
    expect(result.code).toBe(2);
    expect(result.output).toContain('BLOCKED production relay URL and authentication token are required');
    expect(result.output).not.toContain(wallet);
  });
});
