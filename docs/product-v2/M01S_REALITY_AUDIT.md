# M01-S Project Foundation — Reality Audit

Starting HEAD: `0ace9381343528a3187ff43f4abac9cbd350297a`

## Entities Present Today

### 1. `users`
- Primary identity: `id`, `email`, `display_name`, `role` (`user` | `admin` | `system`), credits.
- No workspace concept attached.

### 2. `studio_projects` (legacy)
- Created by inline DDL in `server/server.js` and captured in migration `0008_legacy_runtime_tables.sql`.
- Schema: `id`, `owner_id` → `users(id)`, `title`, `type` (`story` | `commerce` | `custom`), `status` (`planning` | `building` | `ready` | `live`), `current_stage`, `description`, `cover_url`, `meta` JSONB.
- Used by legacy `/api/studio/projects` CRUD and `StudioListPage` / `StudioStagePage`.
- **Authority verdict:** NOT the long-term Project authority. It lacks `workspace_id`, uses incompatible enum values, and its `type`/`status` semantics are specific to the old M5 pipeline. It cannot represent `general` / `studio` / `short_drama` project types without breaking the legacy UI.

### 3. `projects` table
- **Does not exist.** No `projects` relation in migrations or runtime DDL.

### 4. `workspaces` / workspace membership
- **Do not exist.** No workspace table, no workspace_members, no workspace_id on any resource.

### 5. `generation_tasks` (legacy) / `generation_batches_v2` (V2)
- Both carry `user_id` only. No `workspace_id` or `project_id`.
- `generation_items_v2` belongs to a batch; batches belong to a user.

### 6. `media`
- Carries `user_id`, `task_id`, `reference_style_id`, `character_id`. No project/workspace link.

### 7. `characters`
- Stand-alone; no project/workspace link.

## Routes / Services / Frontend

- Legacy studio routes: `/api/studio/projects` (server.js ~L2869). Auth = session user, owner isolation by `owner_id`.
- V2 preview shell: `/__v2/*` in `src/App.tsx`, `V2App.tsx` currently renders placeholder `Projects`, `Create`, `Studio`, etc.
- V2 nav already lists `Projects` pointing to `/__v2/projects`.
- No `/api/v2/workspaces` or `/api/v2/projects` routes exist.
- Auth middleware: `appGateway` sets `req.user` from `sid` cookie; roles = `user` | `admin` | `system`. No workspace membership checks.

## OpenAPI / Contract

- `contracts/openapi/moling-v2.yaml` only covers `/api/healthz`, `/api/readiness`, `/api/auth/me`.
- `src/shared/api/contract/client.ts` only exposes `v2.getHealth`, `v2.getReadiness`, `v2.getMe`.
- No project/workspace schemas or client.

## Permission Model

- Existing RBAC: role-based (`user` < `admin` < `system`). No resource-level ownership beyond `owner_id` on `studio_projects`/`media`.
- Workspace membership: **none**. Must be introduced.

## Legacy Compatibility Requirement

- `/api/studio/projects`, `StudioListPage`, `StudioStagePage`, and existing `studio_projects` data must keep working unchanged in this branch.

## Answers to the Audit Questions

1. **Current Workspace authority:** none. A workspace concept does not exist.
2. **Current Project authority:** ambiguous. `studio_projects` is the only project-shaped table, but its semantics are tied to the legacy M5 pipeline and it has no workspace boundary.
3. **Does `studio_projects` already carry Project authority?** Yes for the legacy Studio feature, but not for the new V2 cross-module Project boundary.
4. **Duplicate project concepts?** Today only one table, but a second `projects` authority is required because `studio_projects` cannot be safely evolved to serve both legacy Studio and new V2 modules without breaking legacy enum contracts.
5. **creation / studio_project / workspace relationship:** No `creations` table. `studio_projects` owns user media indirectly through `owner_id` (same user). No workspace.
6. **Generation V2 association:** `user_id` only; no project/workspace link.
7. **media/assets association:** `user_id` only; no project link.
8. **Old API/UI that must stay compatible:** `/api/studio/projects`, `StudioListPage` (`/studio`), `StudioStagePage` (`/studio/:projectId`), legacy `/api/media` owner isolation.

## Conclusion

M01-S must introduce a new **authoritative `workspaces` + `projects`** domain. `studio_projects` is kept intact as a legacy runtime projection and will be reconciled in a later migration, not in this module.
