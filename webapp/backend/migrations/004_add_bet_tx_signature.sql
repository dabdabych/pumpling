DO $$
BEGIN
    IF to_regclass('public.bet_participations') IS NULL THEN
        RAISE NOTICE 'bet_participations table not found; skipping migration';
        RETURN;
    END IF;

    EXECUTE 'ALTER TABLE bet_participations ADD COLUMN IF NOT EXISTS tx_signature VARCHAR(128)';
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_bet_participations_tx_signature ON bet_participations (tx_signature)';
END $$;
