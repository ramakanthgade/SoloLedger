# Cloudflare Workers — Binance gateway

`binance-gateway-worker.js` runs as `sololedger-binance-gateway` on the
account's `sololedger.workers.dev` subdomain. It exists because
`api.binance.com` answers HTTP 451 to US egress and the SoloLedger relay is
pinned to a US region: a Worker executes at the edge PoP closest to the
**caller**, so a browser in a Binance-friendly country (verified: India →
Binance 200; US → 451, which the client maps to the `region_blocked`
message) gets working egress.

It is a byte-verbatim pipe to `api.binance.com` gated by a short-lived HMAC
ticket minted by the relay (`GET /api/exchange-gateway/binance/ticket`,
JWT + active subscription + `exchangeSyncEnabled` flag). The worker only
forwards the `x-mbx-apikey` header — the API secret never leaves the user's
browser (requests are signed client-side by ccxt).

## Deploy / update (Cloudflare API — no wrangler needed)

```bash
export CLOUDFLARE_API_TOKEN=…  # Workers Scripts:Edit on the account
export ACC=8c1da271b71d98990a38c0825602d048
# metadata MUST redeclare the secret binding on every deploy — bindings in
# upload metadata are declarative; omitting the binding silently removes it.
cat > /tmp/cf-meta.json <<'EOF'
{"main_module":"binance-gateway-worker.js","compatibility_date":"2026-07-24",
 "bindings":[{"name":"GATEWAY_SECRET","type":"secret_text","text":"<current secret>"}]}
EOF
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/sololedger-binance-gateway" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "metadata=@/tmp/cf-meta.json;type=application/json" \
  -F "binance-gateway-worker.js=@binance-gateway-worker.js;type=application/javascript+module"
shred -u /tmp/cf-meta.json
```

Note: the dedicated secrets endpoint
(`POST …/workers/scripts/{name}/secrets`) rejects this token shape with
`10405 Method not allowed for this authentication scheme` — the
binding-in-metadata PUT above is the working path.

## Rotating GATEWAY_SECRET

1. Generate a new secret (`openssl rand -hex 32`).
2. Redeploy the worker with the new value in the binding (above).
3. Update `BINANCE_GATEWAY_SECRET` on the relay (Railway service variables)
   and redeploy the relay.
4. Old tickets expire on their own within ~10 minutes (clients refresh).

Never commit the secret value to git. It exists in exactly two places:
the Cloudflare binding and the relay env.
