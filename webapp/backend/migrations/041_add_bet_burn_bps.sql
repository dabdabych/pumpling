-- What share of the tokens bought for a commit its wallet asked to have burned,
-- in basis points: 0 is none, 10000 is all of it.
--
-- The choice is made on chain, as a memo in the commit transaction the wallet
-- signed ("pumpling burn 50%"), and this column is only ever written from that
-- transaction: by the backend when the browser reports the commit, and by the
-- events worker when it sees the deposit. No request carries it. See
-- `shared/burn_memo.py`.
--
-- Every commit made before this column existed burned nothing, which is what
-- the default says. Adding a column with a constant default does not rewrite
-- the table.
ALTER TABLE bet_participations
    ADD COLUMN IF NOT EXISTS burn_bps SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE bet_participations
    DROP CONSTRAINT IF EXISTS bet_participations_burn_bps_range;
ALTER TABLE bet_participations
    ADD CONSTRAINT bet_participations_burn_bps_range CHECK (burn_bps BETWEEN 0 AND 10000);
