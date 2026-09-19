-- The observer was removed from the product: the code that wrote to this table
-- no longer exists (see migration 022, which created it). There is no reason to
-- keep an empty table in the schema: it confuses anyone reading the database and
-- lands in every new deployment.
DROP TABLE IF EXISTS observer_published_stats;
