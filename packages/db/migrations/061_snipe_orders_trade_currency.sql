-- Migration 061: Add trade_currency to snipe_orders
ALTER TABLE snipe_orders ADD COLUMN IF NOT EXISTS trade_currency TEXT NOT NULL DEFAULT 'near';

