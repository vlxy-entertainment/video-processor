-- Remove video_path column from video_processing_queue table
-- This column is no longer needed since we use torrent_id and file_id to fetch download URLs from TorBox

-- First, drop the unique constraint on video_path if it exists
ALTER TABLE video_processing_queue DROP CONSTRAINT IF EXISTS video_processing_queue_video_path_key;

-- Drop the index on video_path if it exists
DROP INDEX IF EXISTS idx_video_processing_queue_video_path;

-- Remove the video_path column
ALTER TABLE video_processing_queue DROP COLUMN IF EXISTS video_path;

