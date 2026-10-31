-- 059_ai_swarm_sessions.sql
-- Stores autonomous AI Swarm trading sessions orchestrated via NEAR AI Cloud (TEE)
-- with multi-agent drone sub-accounts and confidential zero-trace settlement.

CREATE TABLE IF NOT EXISTS ai_swarm_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fleet_id UUID REFERENCES race_fleets(id) ON DELETE SET NULL,
    prompt TEXT NOT NULL,
    strategy_type VARCHAR(64) NOT NULL DEFAULT 'stealth_accumulation',
    token_address VARCHAR(256) NOT NULL,
    token_symbol VARCHAR(64),
    total_amount_near NUMERIC(28, 8) NOT NULL,
    drone_count INTEGER NOT NULL DEFAULT 3,
    status VARCHAR(32) NOT NULL DEFAULT 'created', -- 'created', 'review', 'executing', 'completed', 'paused', 'aborted', 'failed'
    stealth_mode BOOLEAN NOT NULL DEFAULT TRUE,
    plan_json JSONB NOT NULL,
    execution_state JSONB DEFAULT '{"completed_tranches": 0, "total_tranches": 0, "filled_amount_near": 0, "tokens_acquired": "0", "tranche_status": []}'::jsonb,
    error_message TEXT,
    tee_attestation JSONB DEFAULT '{"provider": "NEAR AI Cloud", "enclave": "Intel TDX / NVIDIA H100", "verified": true}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_swarm_user ON ai_swarm_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_swarm_created ON ai_swarm_sessions(created_at DESC);
