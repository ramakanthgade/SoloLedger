# Brand icon provenance

Real brand marks used across SoloLedger (connections, transactions, holdings,
onboarding). Hand-drawn approximations are intentionally NOT used — the user
locked "real logos everywhere" on 25 Jul 2026. Each asset's origin and license
below; keep this manifest updated when adding or replacing icons.

Trademark note: every logo remains the property of its respective owner and is
used solely to identify the corresponding service/chain/asset within the app
(nominative use). Do not recolor, redraw, or "re-style" these marks — present
them as shipped. Where a mark needs a tile/chip behind it for legibility (e.g.
OKX's black glyph on dark surfaces), put the tile *behind* the official glyph,
never redraw the glyph.

## Exchanges

| File | Origin | License |
| --- | --- | --- |
| `binance.svg` | Simple Icons (`simple-icons@15`, slug `binance`, brand hex #F0B90B) via jsDelivr `https://cdn.jsdelivr.net/npm/simple-icons@15/icons/binance.svg` | CC0 1.0 |
| `coinbase.svg` | Simple Icons (slug `coinbase`, #0052FF) | CC0 1.0 |
| `okx.svg` | Simple Icons (slug `okx`, #000000) | CC0 1.0 |
| `kucoin.svg` | Simple Icons (slug `kucoin`, #01BC8D) | CC0 1.0 |
| `wazirx.svg` | Simple Icons (slug `wazirx`, #3067F0) | CC0 1.0 |
| `zebpay.svg` | Simple Icons (slug `zebpay`, #2072EF) | CC0 1.0 |
| `coindcx.png` | CoinGecko `/exchanges` API hosted image (50×50, RGBA) | CoinGecko-hosted brand asset; used for identification only |
| `kraken.jpg` | CoinGecko `/exchanges` API hosted image (50×50) — note: JPG, no alpha; render on a light chip in dark mode | CoinGecko-hosted brand asset |
| `coinswitch.svg` | Official site asset `https://coinswitch.co/images/logo.svg`, cropped to the square mark (viewBox 0 0 32 32). CoinSwitch is NOT listed in CoinGecko's exchanges API | Official brand asset; used for identification only |

## Wallets

| File | Origin | License |
| --- | --- | --- |
| `metamask.svg` | RainbowKit official square wallet icon (`metaMaskWallet.svg`) from the RainbowKit repo | MIT |
| `trustwallet.svg` | RainbowKit official square wallet icon (`trustWallet.svg`) | MIT |
| `ledger.svg` | RainbowKit official square wallet icon (`ledgerWallet.svg`) | MIT |
| `phantom.svg` | RainbowKit official square wallet icon (`phantomWallet.svg`) (backup: `https://docs.phantom.com/favicon.svg`) | MIT |
| `trezor.png` | Official `https://trezor.io/favicon/apple-touch-icon.png` (180×180, grayscale mark) | Official brand asset; used for identification only |

## Chains & tokens

| File | Origin | License |
| --- | --- | --- |
| `bitcoin.svg` | Simple Icons (slug `bitcoin`, #F7931A) | CC0 1.0 |
| `ethereum.svg` | Simple Icons (slug `ethereum`; render on a #627EEA tile) | CC0 1.0 |
| `solana.svg` | **Official brand mark** from the Solana brand kit, `https://solana.com/src/img/branding/solanaLogoMark.svg` (purple→mint gradient bars) | Official brand asset; used for identification only |
| `polygon.svg` | Simple Icons (slug `polygon`, #7B3FE4) | CC0 1.0 |
| `tether.svg` | Simple Icons (slug `tether`, #50AF95) | CC0 1.0 |
| `bnb.png` | TrustWallet `assets` repo, `blockchains/binance/info/logo.png` (256×256, RGBA) | TrustWallet-hosted brand asset |
| `usdc.png` | TrustWallet `assets` repo (181×181, RGBA) | TrustWallet-hosted brand asset |

## Adding a new icon

1. Prefer official brand kits, then Simple Icons (CC0), then wallet-standard
   sources (RainbowKit MIT, TrustWallet assets), then CoinGecko-hosted images.
2. Never hotlink at runtime — copy the asset into this directory.
3. Add a row above with the exact origin URL and license.
