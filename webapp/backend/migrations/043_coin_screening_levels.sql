-- What the red-flag check read, kept with its outcome.
--
-- The site showed a verdict ("No red flags") and a sentence about it, which
-- read as if we vouched for the coin. It now shows what was read, rule by rule,
-- the way pump.fun shows its numbers: the creator's share, launch bundles, the
-- bundled launch, the top ten, linked wallets. Those levels and whether the coin
-- was on a live pump.fun curve are kept here. Rows checked before have neither,
-- and the site shows their reasons alone.
ALTER TABLE coin_screenings ADD COLUMN IF NOT EXISTS levels JSON;
ALTER TABLE coin_screenings ADD COLUMN IF NOT EXISTS on_curve BOOLEAN;
