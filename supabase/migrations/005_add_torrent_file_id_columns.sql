-- Add torrent_id and file_id columns to video_processing_queue table
-- These fields are used to fetch download URLs from TorBox

ALTER TABLE video_processing_queue ADD COLUMN IF NOT EXISTS torrent_id TEXT;
ALTER TABLE video_processing_queue ADD COLUMN IF NOT EXISTS file_id TEXT;

-- Add comments to document the columns
COMMENT ON COLUMN video_processing_queue.torrent_id IS 'Torrent ID from TorBox used to fetch download URL';
COMMENT ON COLUMN video_processing_queue.file_id IS 'File ID from TorBox used to fetch download URL';

-- Create indexes for better performance when querying by these fields
CREATE INDEX IF NOT EXISTS idx_video_processing_queue_torrent_id ON video_processing_queue(torrent_id);
CREATE INDEX IF NOT EXISTS idx_video_processing_queue_file_id ON video_processing_queue(file_id);

