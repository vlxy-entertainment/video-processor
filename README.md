# TikTok Video Uploader

A Node.js application that processes videos from a Supabase queue and uploads them to TikTok.

## Features

- **Queue Management**: Processes videos from Supabase database queue
- **Video Processing Pipeline**: Complete video processing with HLS conversion and PNG embedding
- **Hardware-Aware Processing**: Automatically detects and uses GPU acceleration (NVIDIA, AMD, Apple Silicon, Intel Quick Sync)
- **Comprehensive Logging**: Uses Winston for structured logging to files
- **TikTok Integration**: Automated upload to TikTok with account management
- **Graceful Shutdown**: Handles process signals for clean shutdown

## Tech Stack

- **TypeScript**: Type-safe JavaScript with path aliases
- **Node.js**: Runtime environment
- **Supabase**: Database and backend services
- **Winston**: Logging framework
- **Zod**: Schema validation
- **dotenv**: Environment variable management
- **tsconfig-paths**: Path alias resolution
- **ESLint**: Code linting with flat config
- **Prettier**: Code formatting
- **FFmpeg**: Video processing and HLS conversion
- **Sharp**: Image processing for PNG embedding

## Prerequisites

- Node.js 18+ 
- pnpm (recommended) or npm
- Supabase account and project
- FFmpeg installed on your system
- GPU drivers (optional, for hardware acceleration)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd upload-to-tiktok
```

2. Install dependencies:
```bash
pnpm install
```

3. Copy the environment example file:
```bash
cp env.example .env
```

4. Configure your environment variables in `.env`:
```env
# Supabase Configuration
SUPABASE_URL=your_supabase_url_here
SUPABASE_SECRET_KEY=your_supabase_secret_key_here

# Logging Configuration
LOG_LEVEL=info
LOG_FILE_PATH=./logs/app.log

# TikTok Configuration
TIKTOK_API_ENDPOINT=https://www.tiktok.com/
TIKTOK_IMG_CDN=https://p16-webcast.tiktokcdn.com/obj/

# TikTok Upload Batch Configuration
TIKTOK_ITEMS_PER_ACCOUNT=10
TIKTOK_BATCH_DELAY_MS=5000
```

5. Set up the Supabase database by running the migrations:
```sql
-- Run the SQL from supabase/migrations/001_create_video_queue_table.sql
-- in your Supabase SQL editor

-- If the table already exists, run this instead:
-- Run the SQL from supabase/migrations/002_add_status_progress_columns.sql
-- in your Supabase SQL editor
```

## Usage

### Development Mode
```bash
pnpm dev
```

### Production Mode
```bash
pnpm build
pnpm start
```

### Watch Mode (for development)
```bash
pnpm watch
```

## Video Processing Pipeline

The application processes videos through the following steps:

1. **Queue Management**: Videos are added to the processing queue
2. **Video Creation**: A record is created in the `videos` table with `processing` status
3. **Hardware Detection**: Automatically detects available GPU (NVIDIA, AMD, Apple Silicon, Intel Quick Sync)
4. **HLS Conversion**: Converts video to HLS format with hardware acceleration and optimal segment sizing
5. **Metadata Removal**: Removes FFmpeg metadata from TS segments for cleaner files
6. **PNG Embedding**: Embeds TS segments into 1x1 pixel PNG files for TikTok compatibility
7. **Playlist Update**: Updates playlist to reference PNG files instead of TS files
8. **TikTok Upload**: Uploads PNG-embedded segments and playlist to TikTok
9. **Status Updates**: Updates queue and video status to `processed` and `ready`

### Hardware Acceleration

The system automatically detects and uses:
- **NVIDIA**: CUDA acceleration with `h264_nvenc`
- **AMD**: DirectX 11 acceleration with `h264_amf`
- **Apple Silicon**: VideoToolbox acceleration with `h264_videotoolbox`
- **Intel Quick Sync**: Hardware acceleration with `h264_qsv`
- **CPU Fallback**: Standard `libx264` encoding if no GPU is available

## Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `SUPABASE_URL` | Your Supabase project URL | - | Yes |
| `SUPABASE_SECRET_KEY` | Your Supabase service role key (bypasses RLS) | - | Yes |
| `LOG_LEVEL` | Logging level (error, warn, info, debug) | info | No |
| `LOG_FILE_PATH` | Path to the log file | ./logs/app.log | No |
| `TIKTOK_API_ENDPOINT` | TikTok API endpoint | https://www.tiktok.com/ | No |
| `TIKTOK_IMG_CDN` | TikTok CDN URL for images | https://p16-webcast.tiktokcdn.com/obj/ | No |
| `TIKTOK_ITEMS_PER_ACCOUNT` | Uploads per active account per batch (batch size = active accounts × this) | 10 | No |
| `TIKTOK_BATCH_DELAY_MS` | Delay between batch uploads in milliseconds | 5000 | No |

## Database Schema

The application uses a dedicated `video_processing_queue` table:

### Video Processing Queue Table
```sql
-- Create video processing status enum
CREATE TYPE video_processing_status AS ENUM ('queued', 'processing', 'processed', 'failed');

CREATE TABLE video_processing_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_path TEXT NOT NULL UNIQUE,
    index INTEGER NOT NULL,
    status video_processing_status NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

This table stores the queue of videos to be processed, with:
- `video_path`: Path to the video (can be URL or local path)
- `index`: Position in the queue (0-based)
- `status`: Processing status (queued, processing, processed, failed)
- `progress`: Current processing percentage (0-100)
- Automatic timestamps for creation and updates

### Queue Processing Logic
- Only one video is processed at a time
- Videos are processed in order by `index`
- Next video is picked only when current one is `processed` or `failed`
- Status flow: `queued` → `processing` → `processed`/`failed`

## Logging

The application uses Winston for structured logging:

- **Console Output**: Colorized logs for development
- **File Output**: JSON-formatted logs saved to files
- **Error Logs**: Separate error log file
- **Log Levels**: error, warn, info, debug

Log files are created in the `logs/` directory:
- `app.log`: All logs
- `app-error.log`: Error logs only

## How It Works

1. **Initialization**: The application starts and tests the Supabase connection
2. **Video Processing**: Periodically checks the queue for videos with 'queued' status
3. **Hardware Detection**: Automatically detects and uses available GPU acceleration
4. **HLS Conversion**: Converts video to HLS format with optimal settings
5. **PNG Embedding**: Embeds segments into PNG files for TikTok compatibility
6. **TikTok Upload**: Uploads processed segments and playlist to TikTok
7. **Status Updates**: Updates queue and video status throughout the process
8. **Graceful Shutdown**: Handles process signals for clean shutdown

## Error Handling

The application includes comprehensive error handling:

- **Connection Errors**: Validates Supabase connection on startup
- **Processing Errors**: Handles video processing failures gracefully
- **Database Errors**: Logs and handles Supabase operation failures
- **Upload Errors**: Handles TikTok upload failures with retry logic
- **Process Errors**: Catches uncaught exceptions and unhandled rejections

## Development

### Project Structure

```
src/
├── config/          # Configuration files
├── services/        # Business logic services
├── types/           # TypeScript type definitions
├── utils/           # Utility functions
└── index.ts         # Main application entry point
```

### Path Aliases

The project uses TypeScript path aliases for cleaner imports:

- `@/*` - Root of src directory
- `@/config/*` - Configuration files
- `@/services/*` - Service classes
- `@/types/*` - Type definitions
- `@/utils/*` - Utility functions

Example usage:
```typescript
import { logger } from '@/utils/logger';
import { envConfig } from '@/config';
import { QueueService } from '@/services/queueService';
```

### Building

```bash
pnpm build
```

### Cleaning

```bash
pnpm clean
```

### Code Quality

```bash
# Lint and fix code
pnpm lint

# Check linting without fixing
pnpm lint:check

# Format code with Prettier
pnpm format

# Check formatting without fixing
pnpm format:check

# Type checking
pnpm type-check
```

## License

MIT
