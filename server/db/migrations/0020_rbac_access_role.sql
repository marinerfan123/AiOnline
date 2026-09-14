-- 0020_rbac_access_role
-- W1-15: Workspace RBAC role schema.
-- Additive: keeps the legacy `role` ('owner'/'member') for backwards compatibility and adds a
--   six-role `access_role` hierarchy (Owner/Admin/Billing Admin/Editor/Reviewer/Viewer).
-- Deterministic legacy mapping: workspace owner -> 'Owner'; legacy 'member' -> 'Viewer' (least privilege).
-- The workspace row's owner_id is also reflected as 'Owner' when not already set.

ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS access_role TEXT NOT NULL DEFAULT 'Viewer'
  CHECK (access_role IN ('Owner', 'Admin', 'Billing Admin', 'Editor', 'Reviewer', 'Viewer'));

-- Deterministic backfill from the legacy 2-role model (idempotent; only promotes the legacy owner).
UPDATE workspace_members
   SET access_role = 'Owner'
 WHERE role = 'owner' AND access_role = 'Viewer';

-- Ensure the workspace owner row is 'Owner' (member row for the owner, if any).
UPDATE workspace_members wm
   SET access_role = 'Owner'
  FROM workspaces w
 WHERE wm.workspace_id = w.id AND wm.user_id = w.owner_id AND wm.access_role = 'Viewer';

COMMENT ON COLUMN workspace_members.access_role IS
  'W1-15 RBAC: Owner/Admin/Billing Admin/Editor/Reviewer/Viewer (legacy role kept for compat; access_role backfilled deterministically)';
