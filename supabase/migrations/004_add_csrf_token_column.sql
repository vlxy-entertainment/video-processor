-- Add csrftoken column to tiktok_accounts table
ALTER TABLE tiktok_accounts ADD COLUMN csrftoken VARCHAR(255);

-- Add index for better performance when querying by csrftoken
CREATE INDEX IF NOT EXISTS idx_tiktok_accounts_csrftoken ON tiktok_accounts(csrftoken);

-- Add comment to document the column
COMMENT ON COLUMN tiktok_accounts.csrftoken IS 'CSRF token for TikTok API authentication';
