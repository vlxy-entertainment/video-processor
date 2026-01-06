-- Create video processing status enum
CREATE TYPE video_processing_status AS ENUM ('queued', 'processing', 'processed', 'failed');

-- Create video_processing_queue table
CREATE TABLE IF NOT EXISTS video_processing_queue (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    video_path TEXT NOT NULL UNIQUE,
    index INTEGER NOT NULL,
    status video_processing_status NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on video_path for faster lookups
CREATE INDEX IF NOT EXISTS idx_video_processing_queue_video_path ON video_processing_queue(video_path);

-- Create index on index for ordering
CREATE INDEX IF NOT EXISTS idx_video_processing_queue_index ON video_processing_queue(index);

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS idx_video_processing_queue_status ON video_processing_queue(status);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_video_processing_queue_updated_at 
    BEFORE UPDATE ON video_processing_queue 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE video_processing_queue ENABLE ROW LEVEL SECURITY;

-- Create policy to allow all operations (adjust as needed for your security requirements)
CREATE POLICY "Allow all operations on video_processing_queue" ON video_processing_queue
    FOR ALL USING (true);
