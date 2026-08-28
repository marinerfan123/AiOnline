# M01-S Project Foundation — Authority Decision

## Long-Term Model

```
User
  → Workspace (ownership / team / billing / permission boundary)
    → Project (creative production boundary)
      → Studio Canvas
      → Short Drama
      → Assets
      → Generation Tasks
      → Timeline
```

## Authoritative Entities

| Concept | Authoritative Table | Reason |
|---------|---------------------|--------|
| Workspace | `workspaces` | New table; no prior authority. Billing/team boundary starts here. |
| Project | `projects` | New table; `studio_projects` semantics are incompatible. |
| Workspace membership | `workspace_members` | Many-to-many, role per workspace (`owner` | `member`). |

## Why Not Evolve `studio_projects`?

- Its `type` enum (`story`/`commerce`/`custom`) and `status` enum (`planning`/`building`/`ready`/`live`) are consumed by the legacy Studio UI.
- It has no `workspace_id`; adding one would still leave `current_stage`, `meta` and incompatible enums in the same row.
- Evolving it now would force a destructive migration and break the legacy Studio feature before M05-A is ready.

## Legacy Compatibility Model

- `studio_projects` remains unchanged in M01-S.
- Legacy `/api/studio/projects` continues to read/write `studio_projects`.
- The new `projects` table is the single V2 authority. A future reconciliation migration will link or backfill `studio_projects` into `projects` (e.g. via a `legacy_studio_project_id` column).

## Role Model

- Workspace roles: `owner`, `member`.
- Existing global roles (`user`/`admin`/`system`) remain. `admin`/`system` bypass workspace membership checks for support/debug.
- Project access: `owner` of the workspace, `member` of the workspace, or global admin/system.

## Decision

Introduce new `workspaces` + `workspace_members` + `projects` tables. Do not modify `studio_projects` in this module.
