-- Migration 064: AI Swarm sessions no longer claim a verified TEE attestation.
-- The planner never verified one; new rows store who planned the swarm instead.
ALTER TABLE ai_swarm_sessions ALTER COLUMN tee_attestation SET DEFAULT '{}'::jsonb;
