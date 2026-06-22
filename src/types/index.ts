import { z } from 'zod';
import type { Database } from '@/types/database';

/**
 * Schema for environment configuration
 */
export const EnvConfigSchema = z.object({
  SUPABASE_URL: z.string().url('Invalid Supabase URL'),
  SUPABASE_SECRET_KEY: z.string().min(1, 'Supabase secret key is required'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FILE_PATH: z.string().default('./logs/app.log'),
  TIKTOK_API_ENDPOINT: z.string().url('Invalid TikTok API endpoint'),
  TIKTOK_ITEMS_PER_ACCOUNT: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().min(1))
    .default('10'),
  TIKTOK_BATCH_DELAY_MS: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().min(1000))
    .default('5000'),
  TIKTOK_IMG_CDN: z.string().default('https://p21-ad-sg.ibyteimg.com/obj/'),
  TORBOX_TOKEN: z.string().min(1, 'TorBox token is required'),
  MAX_SEGMENT_SIZE_MB: z
    .string()
    .transform(val => parseFloat(val))
    .pipe(z.number().positive())
    .default('5'),
  SEGMENT_SIZE_SAFETY_MARGIN: z
    .string()
    .transform(val => parseFloat(val))
    .pipe(z.number().positive().max(1))
    .default('0.8'),
  HLS_SEGMENT_DURATION_SECONDS: z
    .string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .default('5'),
});

/**
 * Environment configuration type
 */
export type EnvConfig = z.infer<typeof EnvConfigSchema>;

/**
 * Which processing route the planner selected for a source.
 * - `remux`: stream-copy (`-c copy`) into HLS — no re-encode, no GPU.
 * - `transcode`: re-encode through the encoder ladder.
 */
export const ProcessingRouteSchema = z.enum(['remux', 'transcode']);

/**
 * The route to take for a source.
 */
export type ProcessingRoute = z.infer<typeof ProcessingRouteSchema>;

/**
 * Schema for a processing plan produced by the ProcessingPlanner.
 */
export const ProcessingPlanSchema = z.object({
  /** Selected route. */
  route: ProcessingRouteSchema,
  /** Human-readable reason the route was chosen (for logs). */
  reason: z.string(),
  /** Predicted worst-case segment size in MB (undefined when probing failed). */
  predictedMaxSegmentMB: z.number().optional(),
});

/**
 * A processing plan: the route plus why it was chosen.
 */
export type ProcessingPlan = z.infer<typeof ProcessingPlanSchema>;

/**
 * Database enum types
 */
export type VideoProcessingStatus = Database['public']['Enums']['video_processing_status'];
export type VideoStatus = Database['public']['Enums']['video_status'];
export type TiktokAccountStatus = Database['public']['Enums']['tiktok_account_status'];

/**
 * Schema for video processing queue item
 * Note: index can be -1 for high priority items, or >= 0 for normal items
 */
export const VideoProcessingQueueItemSchema = z.object({
  id: z.string().uuid().optional(),
  index: z.number().int().min(-2), // Allow -2 for priority items
  status: z.enum(['queued', 'processing', 'processed', 'failed']).default('queued'),
  progress: z.number().int().min(0).max(100).default(0),
  video_name: z.string().nullable().optional(),
  video_description: z.string().nullable().optional(),
  torrent_id: z.string().nullable().optional(),
  file_id: z.string().nullable().optional(),
  release_date: z.string().nullable().optional(),
  actresses: z.string().nullable().optional(),
  thumbnail_url: z.string().nullable().optional(),
  video_network: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

/**
 * Video processing queue item type
 */
export type VideoProcessingQueueItem = z.infer<typeof VideoProcessingQueueItemSchema>;

/**
 * Schema for video record (using existing videos table)
 */
export const VideoSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['uploaded', 'pending', 'processing', 'ready', 'failed']).default('uploaded'),
  hls_playlist_url: z.string().nullable().optional(),
  thumbnail_url: z.string().nullable().optional(),
  release_date: z.string().nullable().optional(),
  video_network_id: z.string().uuid().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

/**
 * Video type
 */
export type Video = z.infer<typeof VideoSchema>;

/**
 * Schema for TikTok account
 */
export const TiktokAccountSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string(),
  aadvid: z.string(),
  sid_guard_ads: z.string(),
  csrftoken: z.string().nullable().optional(),
  status: z.enum(['active', 'limited', 'inactive']).default('active'),
  upload_count: z.number().int().min(0).default(0),
  last_upload_at: z.string().nullable().optional(),
  cooldown_until: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

/**
 * TikTok account type
 */
export type TiktokAccount = z.infer<typeof TiktokAccountSchema>;
