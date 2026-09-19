DO $$
BEGIN
    IF to_regclass('public.bet_participations') IS NULL THEN
        RAISE NOTICE 'bet_participations table not found; skipping migration';
        RETURN;
    END IF;

    ALTER TABLE public.bet_participations
        ADD COLUMN IF NOT EXISTS confirmation_status VARCHAR(16),
        ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS last_confirmation_check_at TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS orphan_reason TEXT NULL;

    UPDATE public.bet_participations
    SET
        confirmation_status = COALESCE(confirmation_status, 'finalized'),
        confirmed_at = COALESCE(confirmed_at, created_at, NOW()),
        finalized_at = COALESCE(finalized_at, created_at, NOW())
    WHERE confirmation_status IS NULL;

    ALTER TABLE public.bet_participations
        ALTER COLUMN confirmation_status SET DEFAULT 'confirmed',
        ALTER COLUMN confirmation_status SET NOT NULL;

    CREATE INDEX IF NOT EXISTS ix_bet_participations_confirmation_status
        ON public.bet_participations (confirmation_status);

    CREATE INDEX IF NOT EXISTS ix_bet_participations_confirmation_check
        ON public.bet_participations (confirmation_status, last_confirmation_check_at, created_at)
        WHERE confirmation_status = 'confirmed';
END $$;
