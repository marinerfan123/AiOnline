# W1 Discovery Report

Date: 2026-09-01  
Worktree: `p1/w1-codex`  
Audited baseline: `b0f4be21a2ccd748f4373f80fdce077032ddd729`

## Decision

The repository does **not** contain enough evidence to define the real scope of
Product P1 W1. No implementation was started. Selecting a feature from the
existing phase plans would invent a W1 scope and could start later work (in
particular Studio execution work) without authorization.

This report is therefore the only W1 change, as required when discovery cannot
establish the scope.

## Audit coverage

The read-only discovery covered:

- all 48 files under `docs/`, including product V2 plans, architecture,
  operations, security, migration governance, scope, Hermes state, module
  contracts, and the G0 report;
- repository filenames and contents matching roadmap, plan, TODO, task,
  manifest, W1, Phase 1, and Product P1;
- `harness/`, its runners, schemas, fixtures, and committed evidence;
- `deploy/generation-v2/`, `server/modules/generation-v2/`, Studio/canvas,
  agent, workflow, shared contracts, server routes, and their tests;
- root and server package scripts, CI workflows, E2E tests, and unit/integration
  test inventories;
- all local/remote branch names, tags, and git history, including content and
  commit-message searches for `W1`, `Week 1`, `P1-W1`, `Phase 1`, and
  `Product P1`.

The worktree was clean and its HEAD exactly matched the requested G0 baseline
before this report was created. No other worktree, checkout, database,
production configuration, or remote was modified.

## What the repository actually defines

### Product boundary (authoritative for inclusion, not W1 sequencing)

`docs/scope/S1-0-product-scope-manifest.md` locks Product 1.0 to the AI-native
commercial video production OS. Project foundation, Studio V2, AI control, and
the admin backbone are in scope. Shop/Marketplace, Agent Lab, and generic
workflow surfaces are default-off and firewalled.

This establishes what W1 must not expand into, but does not identify a W1
deliverable.

### Product and module plans (larger than W1)

`docs/product-v2/12-ui-rewrite-plan.md` defines phases A through I with phase
acceptance statements. `docs/product-v2/13-migration-plan.md` defines phase
dependencies. `docs/product-v2/14-uat-plan.md` defines UAT S1 through S8 and a
release-level rule: all scenarios pass with evidence and no unresolved P0/P1.

The implemented module lineage uses a different taxonomy: M00, M01-S, M02-A,
M02-B, M04-S, and M05-A/B1/B2/C/D1. None of these documents or commits maps a
module or phase to W1.

The August `Phase 1` references are an older engineering-productionization
program (test baseline, API harness, reconciliation, CI, migrations, DR, and
security). `docs/hermes/PROJECT_STATE.md` records it as complete. It is not
evidence that the current Product P1 W1 should repeat or extend that program.

### G0 handoff

`docs/audit/G0_CODEX_FINAL_REPORT.md` proves three foundation gates:

- scope firewall implemented and tested;
- migration governance implemented, with immutable `0016` and next allocation
  `0017`;
- Golden Path harness structure implemented, while GP01, GP02, and GP03 remain
  explicitly `NOT_READY` skeletons.

G0 does not state which Golden Path, product phase, module, or defect set is W1.

## Requested W1 facts and findings

| Required fact | Finding | Evidence status |
|---|---|---|
| Real W1 scope | No W1/Week 1/P1-W1 scope statement exists in reachable repository history | Missing |
| W1 dependencies | Product firewall and G0 gates are certain; feature-specific dependencies cannot be selected | Partial |
| W1 goals | No W1 goal or user outcome is named | Missing |
| W1 acceptance criteria | Phase/UAT and module criteria exist, but none is assigned to W1 | Missing |
| W1 task manifest / owner | No W1 manifest, issue export, owner, or milestone mapping exists | Missing |
| W1 implementation status | Cannot classify against an undefined task list | Blocked by missing scope |

## Existing implementation state (not a proposed W1 scope)

The following is a factual repository inventory. It is included to make a
future W1 mapping quick; it must not be read as authorization to implement all
or any of it.

### Implemented

- G0 scope firewall, migration governance, and Golden Path schema/aggregation
  skeleton.
- V2 platform shell and design system foundation (M00).
- Project/workspace foundation (M01-S).
- AI control foundation and provider/key-pool control plane (M02-A/B).
- Asset foundation (M04-S).
- Studio infinite canvas, production node schema/core nodes, durable canvas
  persistence, and the durable run-engine foundation (M05-A through D1).
- Generation V2 production runtime, reconciliation, billing safety,
  observability, provider admission, and extensive server tests.

### Partially implemented

- The broad product V2 rewrite: its plan predates several implemented modules
  and has not been reconciled into a current module-to-phase completion matrix.
- Studio/short-drama product flow: canvas and run foundations exist, but the
  13-stage guided drama flow and end-to-end product acceptance are not proven.
- Golden Path automation: result schema, aggregation, runner entry points, and
  step lists exist, but every GP01/GP02/GP03 step is deliberately
  `NOT_READY` and emits no real acceptance evidence.
- Production rollout acceptance: historical documentation records real-staging
  items such as native PostgreSQL DR and SSE/load-balancer checks; those are
  environment-dependent and are not identified as W1.

### Not implemented or not proven

- A repository-backed W1 manifest and W1-specific acceptance suite.
- GP01 short-drama full path, GP02 commercial smoke, and GP03 e-commerce smoke
  execution in the harness.
- Release-level UAT S1-S8 evidence required by the V2 UAT plan.
- Product-plan gaps that remain explicitly deferred or disabled, including TTS,
  server-side final video composition, and multi-user canvas collaboration.

## Dependencies that can be asserted safely

Any valid W1 must:

1. start from G0 baseline `b0f4be2` and preserve the scope firewall;
2. stay inside the 1.0 commercial-video product boundary;
3. preserve the certified Generation V2 accounting, lease/fencing, and
   reconciliation invariants;
4. use migration governance and reserve `0017` or later if schema work is
   explicitly in scope;
5. define executable acceptance evidence and distinguish `NOT_READY` from
   `FAIL` and `PASS` honestly;
6. retain existing dependencies unless a scoped requirement proves a new one is
   necessary;
7. avoid W6-08, production DB/config changes, and out-of-scope Shop, Agent Lab,
   or generic workflow enablement.

Feature-specific dependency chains cannot be asserted until W1 is mapped to a
named outcome. For example, GP01 depends on substantially different product
work than a provider-control or deployment-hardening W1.

## P0/P1 blockers

### Current W1 blocker

| ID | Severity | Blocker | Resolution required |
|---|---|---|---|
| W1-B01 | P0 (planning) | No authoritative W1 scope or acceptance contract exists | Supply the W1 brief/manifest or an explicit mapping to an existing phase/module/Golden Path |
| W1-B02 | P1 (planning) | Product V2 plan, implemented M-series modules, and G0 Golden Paths use three unmapped taxonomies | State which taxonomy controls W1 and reconcile the selected items |
| W1-B03 | P1 (acceptance) | No W1-specific test/evidence command or deployable exit gate is named | Define required scenarios, environment, fixtures, and pass thresholds |

These are external specification blockers, not code defects. Implementing code
cannot resolve them without choosing product behavior on behalf of the owner.

### Historical P0/P1 findings that are not proven current W1 blockers

`docs/architecture/COMMERCIAL_SINGLE_NODE_GAP_MATRIX.md` lists P0/P1 gaps from
an earlier single-node audit. Later commits and `docs/hermes/CHECKPOINT.md`
record commercial correctness with zero open P0/P1, and current source contains
readiness, PG SSL, distributed admission, SSE, and shutdown remediation. The
matrix is therefore useful historical context, not a safe current W1 backlog.

The release UAT rule requires zero unresolved P0/P1, but the repository has no
current W1 defect manifest from which a W1 P0/P1 count can be computed. The
Golden Path metrics accordingly remain `null`, not zero.

## Minimum implementable plan after scope is supplied

The smallest safe W1 plan is:

1. Add a versioned W1 manifest naming one user outcome, authoritative source
   files, explicit non-goals, dependencies, and an itemized DoD.
2. Map every W1 item to current code/tests and mark it implemented, partial, or
   missing; resolve contradictions between the 2026-08-27 product plan and
   later M-series implementation.
3. Implement only the missing vertical slice, behind existing feature gates,
   with reversible migrations only if the manifest requires schema changes.
4. Add targeted unit/integration/E2E coverage and wire one W1 acceptance runner
   that produces real, portable evidence without writing tracked runtime data.
5. Run targeted tests, typecheck, deploy/build validation appropriate to the
   slice, and `git diff --check`; record the exact results and commit.

Minimum external input needed: one unambiguous statement such as “W1 = GP01
steps X–Y”, “W1 = Product Phase B/UAT S1”, or “W1 = module M05-D2 contract
<document>”, plus any environment-dependent acceptance requirements. Without
that mapping, these choices have materially different products, migrations,
risks, and completion criteria.

## Safety conclusion

Discovery found no evidence sufficient to authorize a W1 implementation.
Per the task rule, this report is the complete deliverable. W6-08 was not
started or inspected as an implementation target; no dependency, deployment,
database, production configuration, remote, main checkout, or sibling worktree
was changed.
