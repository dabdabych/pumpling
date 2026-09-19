DO $$
DECLARE
    enum_type text;
BEGIN
    IF to_regclass('public.lotteries') IS NULL THEN
        RAISE NOTICE 'lotteries table not found; skipping migration';
        RETURN;
    END IF;

    SELECT t.typname
    INTO enum_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE c.relname = 'lotteries'
      AND a.attname = 'status'
      AND t.typtype = 'e';

    IF enum_type IS NULL THEN
        RAISE NOTICE 'lottery status enum not found; skipping migration';
        RETURN;
    END IF;

    EXECUTE format(
        'UPDATE lotteries SET status = %L::%I WHERE status::text = %L',
        'created',
        enum_type,
        'active'
    );
    EXECUTE format(
        'UPDATE lotteries SET status = %L::%I WHERE status::text = %L',
        'completed',
        enum_type,
        'finished'
    );
    EXECUTE format(
        'UPDATE lotteries SET status = %L::%I WHERE status::text = %L',
        'cancelled',
        enum_type,
        'canceled'
    );
END $$;
