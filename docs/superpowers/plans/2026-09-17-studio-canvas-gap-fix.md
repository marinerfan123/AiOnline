# Studio Infinite Canvas Gap Fix

## Goal

Restore the unfinished infinite-canvas flows identified in production: the AI model catalog must remain available when no provider bindings exist, and the composer Generate action must dispatch the existing node-run pipeline after saving edits.

## Scope

- Add a repository regression test for an enabled model with zero provider bindings.
- Guard the provider lookup against an empty provider-id set.
- Add a composer regression test and wire Generate to `runNode`.
- Pass the current canvas revision into the composer so its run context is complete.
- Run targeted tests, typecheck, build, then rebuild and verify the production service.
- Do not invent provider bindings, capabilities, credentials, or upstream model configuration.

## Verification

1. Regression tests fail before each corresponding fix and pass afterward.
2. Targeted Vitest and Node tests pass.
3. Typecheck and production build pass.
4. Production `/api/v2/ai-control/models` no longer returns the empty-array SQL 500.
5. Studio Generate triggers one FROM_NODE run and does not re-submit on style selection.
