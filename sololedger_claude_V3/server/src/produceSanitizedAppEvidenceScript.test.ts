import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const capture = (extra: Record<string, unknown> = {}) => ({
  captureVersion: 'b6-browser-capture-v2', captureMethod: 'playwright-rendered-ui',
  dashboardNetWorth: 103_071, connectionsNetWorth: 103_071, featureEnabled: true,
  shadowStatus: 'complete',
  targetUrl: 'https://app.example.test/SoloLedger/?ignored=yes#ignored', buildSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authenticatedRunId: 'run-123',
  screenshots: [
    { name: 'dashboard', sha256: '1'.repeat(64) },
    { name: 'connections', sha256: '2'.repeat(64) },
    { name: 'allocation', sha256: '3'.repeat(64) }
  ],
  selectors: ['[data-testid="net-worth-value"]', '[data-testid="detail-holdings-total"]'],
  ...extra
});

function runProducer(input: string, output: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      'scripts/produce-sanitized-app-evidence.mjs', '--input', input, '--output', output
    ], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env, TARGET_URL: 'https://app.example.test/SoloLedger/',
        EXPECTED_BUILD_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        AUTHENTICATED_BROWSER_RUN_ID: 'run-123',
        APP_EVIDENCE_SIGNING_KEY: 'test-signing-key-that-is-at-least-32-bytes'
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('attested browser app-evidence producer', () => {
  it('emits only versioned rendered evidence, a deterministic hash, and mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sololedger-app-evidence-'));
    const input = join(directory, 'capture.json');
    const output = join(directory, 'evidence.json');
    const secret = 'secret-marker-must-not-survive';
    await writeFile(input, JSON.stringify(capture({ wallet: `0x${'a'.repeat(40)}`, apiKey: secret })));

    const result = await runProducer(input, output);
    expect(result).toEqual({ code: 0, stdout: 'PASS attested browser app evidence written\n', stderr: '' });
    const evidence = JSON.parse(await readFile(output, 'utf8'));
    expect(evidence).toMatchObject({
      evidenceVersion: 'b6-browser-evidence-v2', captureVersion: 'b6-browser-capture-v2',
      captureMethod: 'playwright-rendered-ui', dashboardNetWorth: 103_071,
      connectionsNetWorth: 103_071, featureEnabled: true, shadowStatus: 'complete',
      targetUrl: 'https://app.example.test/SoloLedger', buildSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      authenticatedRun: { method: 'ci-hmac', runId: 'run-123' },
      screenshots: expect.arrayContaining([
        { name: 'dashboard', sha256: '1'.repeat(64) },
        { name: 'connections', sha256: '2'.repeat(64) },
        { name: 'allocation', sha256: '3'.repeat(64) }
      ]),
      attestation: { algorithm: 'hmac-sha256', digest: expect.stringMatching(/^[0-9a-f]{64}$/) }
    });
    expect(JSON.stringify(evidence)).not.toMatch(/wallet|apiKey|secret-marker/i);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it('atomically replaces a preexisting permissive destination and explicitly restores 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sololedger-app-evidence-mode-'));
    const input = join(directory, 'capture.json');
    const output = join(directory, 'evidence.json');
    await writeFile(input, JSON.stringify(capture()));
    await writeFile(output, 'old evidence', { mode: 0o644 });
    await chmod(output, 0o644);
    expect((await stat(output)).mode & 0o777).toBe(0o644);
    expect((await runProducer(input, output)).code).toBe(0);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(output, 'utf8')).evidenceVersion).toBe('b6-browser-evidence-v2');
  });

  it.each([
    ['missing file', undefined],
    ['malformed JSON', '{"apiKey":"secret-marker",'],
    ['unattested caller booleans', JSON.stringify({ dashboardNetWorth: 1, connectionsNetWorth: 1, featureEnabled: true })],
    ['disabled feature', JSON.stringify(capture({ featureEnabled: false }))],
    ['missing screenshot hashes', JSON.stringify(capture({ screenshots: [] }))],
    ['wrong deployed origin', JSON.stringify(capture({ targetUrl: 'https://other.example.test/SoloLedger/' }))],
    ['same-origin wrong base path', JSON.stringify(capture({ targetUrl: 'https://app.example.test/Other/' }))],
    ['wrong build SHA', JSON.stringify(capture({ buildSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }))],
    ['wrong authenticated run', JSON.stringify(capture({ authenticatedRunId: 'other-run' }))]
  ])('uses one generic redacted failure for %s and writes no output', async (_label, contents) => {
    const directory = await mkdtemp(join(tmpdir(), 'sololedger-invalid-evidence-'));
    const input = join(directory, 'secret-marker-input.json');
    const output = join(directory, 'evidence.json');
    if (contents != null) await writeFile(input, contents);
    const result = await runProducer(input, output);
    expect(result).toEqual({ code: 1, stdout: '', stderr: 'FAIL app evidence production failed\n' });
    expect(`${result.stdout}${result.stderr}`).not.toContain('secret-marker');
    await expect(readFile(output)).rejects.toThrow();
  });
});
