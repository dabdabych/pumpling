DO $$
BEGIN
    IF to_regclass('public.lotteries') IS NULL THEN
        RAISE NOTICE 'lotteries table not found; skipping migration';
        RETURN;
    END IF;

    ALTER TABLE public.lotteries
        ADD COLUMN IF NOT EXISTS proceeding_purchases_started_at TIMESTAMPTZ NULL;
END $$;
