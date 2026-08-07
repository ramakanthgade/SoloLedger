import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const pagesWorkflow = readFileSync(
  resolve(projectRoot, '../.github/workflows/deploy-pages.yml'),
  'utf8'
);

describe('GitHub Pages wallet DeFi rollout gate', () => {
  it('keeps the supported manual Pages build and deploy path explicitly promoted', () => {
    expect(packageJson.devDependencies['cross-env']).toBeTruthy();
    expect(packageJson.scripts['build:pages']).toMatch(/^cross-env\s/);
    expect(packageJson.scripts['build:pages']).toMatch(
      /(?:^|\s)VITE_WALLET_DEFI_NET_WORTH_V1=true(?:\s|$)/
    );
    expect(packageJson.scripts['deploy:pages']).toContain('npm run build:pages');
  });

  it('keeps the GitHub Pages workflow build explicitly promoted', () => {
    expect(pagesWorkflow).toMatch(
      /- name: Build for GitHub Pages \(SaaS\)[\s\S]*?run: npm run build[\s\S]*?VITE_WALLET_DEFI_NET_WORTH_V1: ['"]true['"]/
    );
  });
});
