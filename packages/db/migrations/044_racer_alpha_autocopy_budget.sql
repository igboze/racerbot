CREATE TABLE IF NOT EXISTS racer_alpha_autocopy_daily_usage (
    buyer_user_id TEXT NOT NULL,
    usage_date DATE NOT NULL,
    spent_near NUMERIC(16, 6) NOT NULL DEFAULT 0,
    PRIMARY KEY (buyer_user_id, usage_date)
);
