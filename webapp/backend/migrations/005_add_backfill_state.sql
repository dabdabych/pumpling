DO $$
BEGIN
    IF to_regclass('public.backfill_state') IS NOT NULL THEN
        RETURN;
    END IF;

    EXECUTE '
        CREATE TABLE backfill_state (
            id VARCHAR(128) PRIMARY KEY,
            last_signature VARCHAR(128),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    ';
END $$;
