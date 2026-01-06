-- Convert status columns from varchar to enum types
-- Create enum types for status columns
CREATE TYPE tiktok_account_status AS ENUM ('active', 'limited', 'inactive');
CREATE TYPE video_status AS ENUM ('ready', 'processing', 'failed');

-- Update tiktok_accounts table to use enum
-- First, add a new column with the enum type
ALTER TABLE tiktok_accounts ADD COLUMN status_new tiktok_account_status DEFAULT 'active';

-- Update existing data to match enum values
-- Map existing varchar values to enum values
UPDATE tiktok_accounts SET status_new = 
    CASE 
        WHEN status = 'active' THEN 'active'::tiktok_account_status
        WHEN status = 'limited' THEN 'limited'::tiktok_account_status
        WHEN status = 'inactive' THEN 'inactive'::tiktok_account_status
        ELSE 'active'::tiktok_account_status  -- default fallback
    END;

-- Drop the old column and rename the new one
ALTER TABLE tiktok_accounts DROP COLUMN status;
ALTER TABLE tiktok_accounts RENAME COLUMN status_new TO status;

-- Update videos table to use enum
-- First, add a new column with the enum type
ALTER TABLE videos ADD COLUMN status_new video_status;

-- Update existing data to match enum values
-- Map existing varchar values to enum values
UPDATE videos SET status_new = 
    CASE 
        WHEN status = 'uploaded' OR status = 'ready' THEN 'ready'::video_status
        WHEN status = 'processing' THEN 'processing'::video_status
        WHEN status = 'failed' THEN 'failed'::video_status
        ELSE 'ready'::video_status  -- default fallback
    END;

-- Drop the old column and rename the new one
ALTER TABLE videos DROP COLUMN status;
ALTER TABLE videos RENAME COLUMN status_new TO status;

-- Add default value for videos status
ALTER TABLE videos ALTER COLUMN status SET DEFAULT 'ready';

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_tiktok_accounts_status ON tiktok_accounts(status);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
