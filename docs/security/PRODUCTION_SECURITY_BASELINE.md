# PRODUCTION SECURITY BASELINE

Moling AI — Phase 1 Step 7 (2026-08-23)

## Authentication

| Control | Status |
|---------|--------|
| Password hashing | scrypt (16-byte salt, 64-byte key, timing-safe compare) |
| JWT algorithm | HMAC-SHA256 |
| JWT secret | `JWT_SECRET` env var; dev fallback `dev-only-change-me` |
| Session expiry | 7 days |
| Cookie flags | `HttpOnly; SameSite=Strict; Path=/; Max-Age=N` |
| Secure flag | Conditional on HTTPS (via `isHttps()` checking `req.secure`, `req.connection.encrypted`, `X-Forwarded-Proto`) |
| Login rate limiting | Via `rateLimitRedis` (Redis or memory fallback) |
| Register rate limiting | Via `rateLimitRedis` |
| Setup/init rate limiting | Per-IP memory window: 20 attempts / 10min |

## Session/Cookie

- Cookie name: `sid` (session), `rid` (refresh token)
- `SameSite=Strict` (was `Lax`, hardened in Step 7)
- `HttpOnly` always set
- `Secure` set only when HTTPS detected (supports bare-IP dev + nginx HTTPS prod)
- Logout clears both `sid` and `rid` with `Max-Age=0`

## CSRF

- `SameSite=Strict` prevents cross-site cookie submission
- No explicit CSRF token (not required with Strict + JSON APIs)
- Stateless JSON endpoints; cookie-only auth

## CORS

- `CORS_ORIGIN` env var: trusted origin for production
- If unset in production: **no `Access-Control-Allow-Origin` header** (same-origin only)
- If unset in dev/test: `*` (permissive)
- Preflight OPTIONS handled separately
- Admin SSE endpoints: CORS wildcard removed

## Security Headers

Applied via `applySecurityHeaders()` middleware on all JSON responses:

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=()` |
| `Content-Security-Policy` | `default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https: ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (production only) |

## Authorization

- `requireAdmin()` in `admin.cjs`: checks `req.user.role === 'admin'` or `'system'`
- `requireUser()` in payment routes: checks session cookie
- Admin routes all gated behind `requireAdmin()`
- Normal user cannot: create/update/delete providers, manage keys, modify OSS, access admin finance, access admin monitoring
- Anonymous requests rejected with 401/403

## IDOR

- Media endpoints scoped to `user_id`
- Generation tasks scoped to `user_id`
- Recharge orders scoped to `user_id`
- Credit transactions scoped to `user_id`
- Characters scoped to `owner_id`
- Studio projects scoped to `owner_id`
- Reference styles: public read, owner-only update/delete

## Setup Security

- `/api/setup/init`: creates first admin, then locked
- After first admin: returns 409 `already_initialized`
- Per-IP rate limiting: 20 attempts / 10min
- Transactional: all-or-nothing bootstrap
- Admin password minimum: 8 characters
- Admin email validation required

## Rate Limiting

- Fixed window via `rateLimitRedis` (Redis-backed, memory fallback)
- Applied to: login, register, generation, payment
- Webhook endpoints: no rate limiting (payment provider callbacks), but signature verification protects against forgery
- Test env: rate limiting skipped

## Secrets

| Secret | Storage | Exposure |
|--------|---------|----------|
| JWT | `JWT_SECRET` env | Never exposed |
| DB | `PG_*` env vars | Never exposed |
| Redis | `REDIS_*` env vars | Never exposed |
| Provider API keys | DB (`providers.api_key`, `api_keys`) | Masked in API (`***xxxx`) |
| OSS credentials | DB (`oss_config`, `oss_configs`) | Admin-only |
| Payment master key | `PAYMENT_MASTER_KEY` env | Never exposed |
| Payment provider secrets | DB encrypted (AES-256-GCM) | Masked in API |
| API token | `API_TOKEN` env or file | Exposed to system admin only |

## Log Redaction

- Error messages to webhook callers: generic only (no DB details)
- Provider error messages: sanitized via `sanitizeErrorMessage()` (truncates, redacts Bearer tokens/API keys)
- Console hook dedup: bounded to 10000 entries with 60s TTL

## Error Leakage

- API errors: generic messages, no stack traces
- Webhook errors: generic "入账失败"
- 404/401: no internal details
- DB errors: logged internally, not returned to client

## SQL Injection

- All queries use parameterized `$1`, `$2` placeholders
- Admin search uses `ILIKE` with params
- Table/column names hardcoded or allowlisted
- No dynamic identifier interpolation from user input

## SSRF

- `/api/proxy-fetch`: SSRF protection added (`ssrf.cjs`)
- Blocks: localhost, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.x.x, CGNAT, IPv6 loopback, cloud metadata endpoints
- DNS resolution check for rebinding protection
- Requires authentication
- `assetFinalize.fetchBytes()`: SSRF check added

## Upload Security

- `sign-upload`: requires authentication
- Object keys namespaced by `user_id`
- Filename sanitization
- Size limits enforced
- Path traversal blocked

## XSS

- React frontend auto-escapes (JSX)
- CSP restricts inline scripts (allows `unsafe-inline` for React inline styles)
- No `dangerouslySetInnerHTML` with user data (1 usage in chart component for static SVG)

## SSE

- `/api/generate/stream`: user-isolated channels, requires auth
- `/api/admin/console/stream`: admin-only, CORS wildcard removed
- `/api/admin/monitor/stream`: admin-only, CORS wildcard removed
- `/api/admin/logs/stream`: admin-only, CORS wildcard removed
- `/api/oss/logs/stream`: admin-only
- Connection cleanup on close/error

## Payment Security

- Signature verification: `provider.verifyWebhook()` with original body + platform key
- Amount verification: callback amount compared to stored order amount
- Idempotency: `webhook_events` unique index + `ON CONFLICT DO NOTHING`
- State guard: already-paid orders return success without re-crediting
- Row-level locking: `FOR UPDATE` prevents concurrent double-processing
- Empty SIGN_SECRET: changed from `''` to `null` (orders store NULL instead of empty HMAC)
- Error messages: generic only

## Billing Security

- Credit reserves: `WHERE col >= amount` atomic check
- Commit/release: idempotent via `_hasPosted()`
- Negative amounts: `reserveCredits` requires `amount > 0`
- Billing chaos tests verify invariants

## Provider Security

- API keys stored in DB, masked in API responses
- Provider endpoints from config, not user input
- Timeouts configured
- Provider reconciliation does not blindly resubmit

## OSS/COS Security

- Credentials admin-only
- Bucket/endpoint not user-overridable
- Signed upload expiration: 1h (PUT), 7d (GET)
- Object key ownership: namespaced by `user_id`
- Delete authorization: requires owner or admin

## Redis Security

- Graceful degradation to memory on failure
- Rate limiting degrades gracefully
- Auth never depends on Redis health

## Database Security

- SSL: configurable via `PGSSLMODE` (production requirement)
- Connection pool: configurable max, timeout, retry
- Migration safety: advisory lock, checksum, transactional, production DB name rejection
- Production DB least privilege: recommended `NO SUPERUSER, NO CREATEDB, NO CREATEROLE`

## Production Environment Validation

- `CORS_ORIGIN` env: trusted origin for production
- `JWT_SECRET` env: required for production
- `PAYMENT_MASTER_KEY` env: required for payment encryption
- `PAYMENT_SIGN_SECRET` env: required for payment order signing
- Migration: rejects production DB names
- DB connection: fails closed (exits process on failure)

## Docker

- Non-root user: recommended via `USER node` in Dockerfile
- Healthcheck: `/api/healthz`
- No secrets baked into image
- `.env` not copied into image
- Port: configurable via `PORT` env

## Nginx

- TLS termination required for production
- `X-Forwarded-Proto` used for HTTPS detection
- `X-Forwarded-For` used for client IP
- SSE: `X-Accel-Buffering: no`
- Body size: default (1MB for webhooks)

## Dependencies

Run `npm audit` for current state. No forced `--force` fixes.

## Remaining Phase 1.5 Requirements

- TLS termination validation (real Nginx)
- Production DB least-privilege role
- DB TLS (`PGSSLMODE=require`)
- Secret manager / rotation
- Encrypted/off-site backups
- PITR (point-in-time recovery)
- Real Provider test credentials
- Real OSS test bucket
- External vulnerability scan
- Load/DoS validation
