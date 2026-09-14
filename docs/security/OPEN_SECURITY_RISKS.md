# OPEN SECURITY RISKS

Moling AI — Phase 1 Step 7 (2026-08-23)

Unresolved evidence-based items only.

| ID | Severity | Evidence | Impact | Current Mitigation | Required Production Action | Category |
|----|----------|----------|--------|-------------------|---------------------------|----------|
| P2-1 | P2 | `JWT_SECRET` defaults to `dev-only-change-me` | Dev/test environments use weak JWT secret | Production requires `JWT_SECRET` env | Enforce non-default `JWT_SECRET` at startup in production | Auth |
| P2-2 | P2 | `CORS_ORIGIN` unset = no CORS header in production | Same-origin only; cross-origin frontend needs `CORS_ORIGIN` | Documented requirement | Set `CORS_ORIGIN` in production | CORS |
| P2-3 | P2 | Payment webhook has no rate limiting | Volumetric attacks could exhaust DB connections | Signature verification blocks forged requests | Add per-IP rate limiting on webhook endpoints | Payment |
| P2-4 | P2 | Realtime SSE `setMaxListeners(0)` allows unlimited listeners | DoS if single user opens thousands of connections | Per-user channel isolation | Cap per-user SSE connections (e.g., max 5) | SSE |
| P2-5 | P2 | `dangerouslySetInnerHTML` in chart.tsx (static SVG) | Theoretical XSS if chart data is attacker-controlled | Currently renders trusted internal metrics | Validate/escape chart data | XSS |
| P2-6 | P2 | Open redirect: no `returnUrl` validation on payment return | Attackers could redirect users after payment | `returnUrl` only used as redirect target, not for auth bypass | Validate `returnUrl` against allowed domains | Open Redirect |
| P2-7 | P2 | Hardcoded PG password fallback `0.0.1abcd` | Dev default password visible in source | Production must set `PG_PASSWORD` env | Fail-closed on missing `PG_PASSWORD` in production | DB |
| P3-1 | P3 | No refresh-token rotation | Stolen refresh token valid until expiry | Short session expiry (7d) | Implement refresh-token rotation (Phase 1.5) | Auth |
| P3-2 | P3 | `PAYMENT_SIGN_SECRET` empty produces NULL sign | Order signatures are NULL instead of empty HMAC | Real signing requires `PAYMENT_SIGN_SECRET` env | Set `PAYMENT_SIGN_SECRET` in production | Payment |
| P3-3 | P3 | No DB TLS by default | DB traffic unencrypted | `PGSSLMODE` configurable | Require `PGSSLMODE=require` in production | DB |
| P3-4 | P3 | `api_key` returned in providers list (masked) | Masked keys visible in response | Masked to `***xxxx` | Consider write-only API for provider keys | API |
| P3-5 | P3 | No HSTS in non-production | Dev/test environments no HSTS | HSTS only in `NODE_ENV=production` | N/A (by design) | Headers |
| P3-6 | P3 | CSP allows `unsafe-inline` for scripts/styles | Required for React inline styles | CSP otherwise restrictive | Consider nonce-based CSP (Phase 1.5) | CSP |
