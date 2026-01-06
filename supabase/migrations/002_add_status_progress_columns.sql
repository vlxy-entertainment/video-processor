-- Add status and progress columns to existing video_processing_queue table
-- First create the enum type if it doesn't exist
DO $$ BEGIN
    CREATE TYPE video_processing_status AS ENUM ('queued', 'processing', 'processed', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add status column if it doesn't exist
DO $$ BEGIN
    ALTER TABLE video_processing_queue ADD COLUMN status video_processing_status NOT NULL DEFAULT 'queued';
EXCEPTION
    WHEN duplicate_column THEN null;
END $$;

-- Add progress column if it doesn't exist
DO $$ BEGIN
    ALTER TABLE video_processing_queue ADD COLUMN progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100);
EXCEPTION
    WHEN duplicate_column THEN null;
END $$;

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS idx_video_processing_queue_status ON video_processing_queue(status);
