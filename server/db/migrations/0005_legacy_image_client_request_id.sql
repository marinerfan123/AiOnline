-- 0005_legacy_image_client_request_id
-- Adds client_request_id to generation_tasks for durable provider submission identity.
-- Once set, recovery MUST NOT blindly resubmit to provider.
-- Safe on both fresh and existing databases (IF NOT EXISTS throughout).

ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS client_request_id TEXT;

-- Recovery invariant: once client_request_id IS NOT NULL, the task has been submitted
-- to a remote provider. Automatic recovery must not create a new provider request.
CREATE INDEX IF NOT EXISTS ix_gt_client_request_id
  ON generation_tasks(client_request_id) WHERE client_request_id IS NOT NULL;
