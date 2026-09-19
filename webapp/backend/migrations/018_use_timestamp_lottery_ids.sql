DO $$
DECLARE
    fk_record RECORD;
BEGIN
    IF to_regclass('public.lotteries') IS NULL THEN
        RAISE NOTICE 'lotteries table not found; skipping migration';
        RETURN;
    END IF;

    IF to_regclass('public.bet_participations') IS NOT NULL THEN
        FOR fk_record IN
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = 'public.bet_participations'::regclass
              AND confrelid = 'public.lotteries'::regclass
        LOOP
            EXECUTE format('ALTER TABLE public.bet_participations DROP CONSTRAINT IF EXISTS %I', fk_record.conname);
        END LOOP;
    END IF;

    ALTER TABLE public.lotteries
        ALTER COLUMN id TYPE BIGINT USING id::BIGINT,
        ALTER COLUMN id DROP DEFAULT;

    IF to_regclass('public.bet_participations') IS NOT NULL THEN
        ALTER TABLE public.bet_participations
            ALTER COLUMN lottery_id TYPE BIGINT USING lottery_id::BIGINT;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'public.bet_participations'::regclass
              AND conname = 'fk_bet_participations_lottery_id'
        ) THEN
            ALTER TABLE public.bet_participations
                ADD CONSTRAINT fk_bet_participations_lottery_id
                FOREIGN KEY (lottery_id) REFERENCES public.lotteries(id);
        END IF;
    END IF;
END $$;
