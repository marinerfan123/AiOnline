-- 0041_continuity_snapshot_fk.sql
-- G14 audit H2 fix: production_continuity_snapshots.shot_id had no FK, so a
-- snapshot row could orphan (or point at a shot of another project). Add the
-- FK against shots(id) with cascade delete; additive + forward-only. Empty or
-- orphaned existing rows are deleted first so ADD CONSTRAINT cannot fail on
-- pre-existing violations (the table is unwired today, so nothing is lost).

DELETE FROM production_continuity_snapshots s
WHERE NOT EXISTS (SELECT 1 FROM shots sh WHERE sh.id = s.shot_id);

ALTER TABLE production_continuity_snapshots
  ADD CONSTRAINT fk_continuity_snapshot_shot
  FOREIGN KEY (shot_id) REFERENCES shots(id) ON DELETE CASCADE;
