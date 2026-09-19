DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'lotteries'
          AND column_name = 'vrf_binded_at'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'lotteries'
          AND column_name = 'second_phase_started_at'
    ) THEN
        ALTER TABLE lotteries RENAME COLUMN vrf_binded_at TO second_phase_started_at;
    ELSIF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'lotteries'
          AND column_name = 'vrf_binded_at'
    ) AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'lotteries'
          AND column_name = 'second_phase_started_at'
    ) THEN
        UPDATE lotteries
        SET second_phase_started_at = COALESCE(second_phase_started_at, vrf_binded_at)
        WHERE second_phase_started_at IS NULL
          AND vrf_binded_at IS NOT NULL;

        ALTER TABLE lotteries DROP COLUMN vrf_binded_at;
    ELSIF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'lotteries'
          AND column_name = 'second_phase_started_at'
    ) THEN
        ALTER TABLE lotteries ADD COLUMN second_phase_started_at TIMESTAMPTZ NULL;
    END IF;
END $$;
