ALTER TABLE public.lotteries
    ADD COLUMN IF NOT EXISTS close_reason VARCHAR(64),
    ADD COLUMN IF NOT EXISTS initialize_abandoned_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS initialize_abandoned_error VARCHAR(1000);
