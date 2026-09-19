DO $$
BEGIN
    IF to_regclass('public.lotteries') IS NULL THEN
        RAISE NOTICE 'lotteries table not found; skipping migration';
        RETURN;
    END IF;

    ALTER TABLE public.lotteries
        ADD COLUMN IF NOT EXISTS lottery_type VARCHAR(32);

    UPDATE public.lotteries
       SET lottery_type = 'pumpfun'
     WHERE lottery_type IS NULL OR btrim(lottery_type) = '';

    ALTER TABLE public.lotteries
        ALTER COLUMN lottery_type SET DEFAULT 'pumpfun';

    ALTER TABLE public.lotteries
        ALTER COLUMN lottery_type SET NOT NULL;

    DROP INDEX IF EXISTS uq_lotteries_id_generated_only;
    DROP INDEX IF EXISTS uq_lotteries_open_by_type;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_lotteries_open_by_type
        ON public.lotteries (lottery_type)
        WHERE status IN ('id_generated', 'created');
END $$;
