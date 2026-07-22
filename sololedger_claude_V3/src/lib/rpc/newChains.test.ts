import { describe, it, expect } from 'vitest';
import { CHAINS, DROPDOWN_HIDDEN_CHAINS, ETHERSCAN_V2_CHAIN_IDS, type ChainId } from '@/lib/rpc/providers';
import { DIRECT_PROBE_CHAINS } from '@/lib/rpc/moralis';

/**
 * Plan v7.1 (2026-07-21) — 27 verified-importable mainnet chains.
 *
 * Every Alchemy slug, numeric chain id and Etherscan V2 id below was
 * live-verified 2026-07-21 by probing the production relay
 * (eth_chainId + alchemy_getAssetTransfers via /api/proxy/alchemy/<slug>)
 * and cross-checked against chainid.network. Native asset symbols were
 * re-verified against chainid.network on 2026-07-21 (fraxtal = FRAX post
 * North Star rebrand, stable = USDT0, settlus = ETH).
 *
 * Wave 1 (20 chains): Alchemy Enhanced API works — primary import path.
 * Wave 2 (7 chains): Alchemy RPC-only — imports work via the existing
 * any-Alchemy-failure → Etherscan V2 fallback (same as mantle).
 */

/** id → [Alchemy network slug, native asset symbol]. */
const WAVE1: Record<string, [string, string]> = {
  abstract: ['abstract-mainnet', 'ETH'],
  apechain: ['apechain-mainnet', 'APE'],
  anime: ['anime-mainnet', 'ANIME'],
  berachain: ['berachain-mainnet', 'BERA'],
  hyperevm: ['hyperliquid-mainnet', 'HYPE'], // Alchemy slug really is hyperliquid-mainnet
  ink: ['ink-mainnet', 'ETH'],
  lens: ['lens-mainnet', 'GHO'],
  monad: ['monad-mainnet', 'MON'],
  mythos: ['mythos-mainnet', 'MYTH'],
  robinhood: ['robinhood-mainnet', 'ETH'],
  rootstock: ['rootstock-mainnet', 'RBTC'],
  ronin: ['ronin-mainnet', 'RON'],
  shape: ['shape-mainnet', 'ETH'],
  settlus: ['settlus-mainnet', 'ETH'],
  soneium: ['soneium-mainnet', 'ETH'],
  story: ['story-mainnet', 'IP'],
  unichain: ['unichain-mainnet', 'ETH'],
  worldchain: ['worldchain-mainnet', 'ETH'],
  zora: ['zora-mainnet', 'ETH'],
  zetachain: ['zetachain-mainnet', 'ZETA']
};

const WAVE2: Record<string, [string, string]> = {
  fraxtal: ['frax-mainnet', 'FRAX'],
  sei: ['sei-mainnet', 'SEI'],
  sonic: ['sonic-mainnet', 'S'],
  plasma: ['plasma-mainnet', 'XPL'],
  stable: ['stable-mainnet', 'USDT0'],
  megaeth: ['megaeth-mainnet', 'ETH'],
  katana: ['katana-mainnet', 'ETH']
};

const NEW_CHAINS: Record<string, [string, string]> = { ...WAVE1, ...WAVE2 };
const NEW_IDS = Object.keys(NEW_CHAINS) as ChainId[];

/** The 14 chains with a (free-tier-verified) Etherscan V2 id. */
const V2_IDS: Record<string, number> = {
  abstract: 2741,
  apechain: 33139,
  berachain: 80094,
  hyperevm: 999,
  monad: 143,
  unichain: 130,
  worldchain: 480,
  fraxtal: 252,
  sei: 1329,
  sonic: 146,
  plasma: 9745,
  stable: 988,
  megaeth: 4326,
  katana: 747474
};

describe('plan v7.1 — CHAINS registry entries', () => {
  it('adds exactly 27 new chains, all wired to Alchemy EVM', () => {
    expect(NEW_IDS).toHaveLength(27);
    for (const id of NEW_IDS) {
      const def = CHAINS.find((c) => c.id === id);
      expect(def, `CHAINS entry for ${id}`).toBeDefined();
      expect(def!.provider).toBe('alchemy_evm');
      expect(def!.needsKey).toBe(true);
    }
  });

  it.each(NEW_IDS)('%s has the verified Alchemy slug and a non-empty native asset', (id) => {
    const def = CHAINS.find((c) => c.id === id)!;
    const [slug, asset] = NEW_CHAINS[id];
    expect(def.alchemyNetwork).toBe(slug);
    expect(def.alchemyNetwork).toMatch(/^[a-z0-9-]+-mainnet$/);
    expect(def.asset).toBe(asset);
    expect(def.asset.trim().length).toBeGreaterThan(0);
  });

  it('keeps chain ids unique across the whole registry', () => {
    const ids = CHAINS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('inserts the new chains after the existing ones and before custom_evm', () => {
    const ids = CHAINS.map((c) => c.id);
    expect(ids[ids.length - 1]).toBe('custom_evm');
    const solanaIdx = ids.indexOf('solana');
    const customIdx = ids.indexOf('custom_evm');
    for (const id of NEW_IDS) {
      expect(ids.indexOf(id)).toBeGreaterThan(solanaIdx);
      expect(ids.indexOf(id)).toBeLessThan(customIdx);
    }
  });
});

describe('plan v7.1 — Etherscan V2 fallback ids', () => {
  it.each(Object.entries(V2_IDS))('%s maps to the verified V2 chainid %i', (id, chainid) => {
    expect(ETHERSCAN_V2_CHAIN_IDS[id as ChainId]).toBe(chainid);
  });

  it('every Wave-2 chain has a V2 id (V2 IS its import path)', () => {
    for (const id of Object.keys(WAVE2) as ChainId[]) {
      expect(ETHERSCAN_V2_CHAIN_IDS[id], `V2 id for ${id}`).toBeDefined();
    }
  });
});

describe('plan v7.1 — auto-detect probes', () => {
  it('DIRECT_PROBE_CHAINS covers all 27 new ids', () => {
    for (const id of NEW_IDS) {
      expect(DIRECT_PROBE_CHAINS.has(id), `DIRECT_PROBE_CHAINS has ${id}`).toBe(true);
    }
  });

  it('every direct-probe chain has something to probe with (Alchemy slug)', () => {
    for (const id of DIRECT_PROBE_CHAINS) {
      const def = CHAINS.find((c) => c.id === id);
      expect(def?.alchemyNetwork, `alchemyNetwork for probe chain ${id}`).toBeTruthy();
    }
  });
});

describe('plan v7.1 — import dropdown', () => {
  it('still hides only fantom; all 27 new chains stay visible', () => {
    expect([...DROPDOWN_HIDDEN_CHAINS]).toEqual(['fantom']);
    for (const id of NEW_IDS) {
      expect(DROPDOWN_HIDDEN_CHAINS.has(id)).toBe(false);
    }
    // The visible dropdown = CHAINS minus the hidden set, so the 27 appear
    // with no duplicate ids (registry uniqueness is pinned above).
    const visible = CHAINS.filter((c) => !DROPDOWN_HIDDEN_CHAINS.has(c.id)).map((c) => c.id);
    for (const id of NEW_IDS) expect(visible).toContain(id);
    expect(visible).not.toContain('fantom');
  });
});
