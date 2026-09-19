ALTER TABLE lotteries
ADD COLUMN IF NOT EXISTS randomness_account VARCHAR(64);
