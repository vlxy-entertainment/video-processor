import path from 'path';
import { promises as fs } from 'fs';
import { logger } from '@/utils/logger';
import { QueueService } from '@/services/queueService';
import { VideoService } from '@/services/videoService';
import { VideoProcessor } from '@/services/videoProcessor';
import { TiktokUploadOrchestrator } from '@/services/tiktokUploadOrchestrator';
import { TorboxService } from '@/services/torboxService';
import { IndexNowService } from '@/services/indexNowService';

/**
 * Service that orchestrates the video processing pipeline
 */
export class ProcessingService {
  private readonly queueService: QueueService;
  private readonly videoService: VideoService;
  private readonly videoProcessor: VideoProcessor;
  private readonly tiktokUploadOrchestrator: TiktokUploadOrchestrator;
  private readonly torboxService: TorboxService;
  private readonly indexNowService: IndexNowService;

  constructor() {
    this.queueService = new QueueService();
    this.videoService = new VideoService();
    this.videoProcessor = new VideoProcessor();
    this.tiktokUploadOrchestrator = new TiktokUploadOrchestrator();
    this.torboxService = new TorboxService();
    this.indexNowService = new IndexNowService();
  }

  /**
   * Processes the next video in the queue
   * @returns Promise that resolves when processing is complete
   */
  async processNextVideo(): Promise<void> {
    const processingStartTime = Date.now();
    const timingBreakdown: Record<string, number> = {};

    try {
      logger.info('Starting video processing pipeline...');

      // Step 1: Get the next item from the queue and atomically claim it
      // The item is already marked as 'processing' by getNextItem()
      const queueItemStartTime = Date.now();
      const queueItem = await this.queueService.getNextItem();
      timingBreakdown['queue_item_fetch'] = Date.now() - queueItemStartTime;

      if (!queueItem) {
        logger.info('No videos in queue to process');
        return;
      }

      if (!queueItem.id) {
        throw new Error('Queue item ID is required');
      }

      const videoName = queueItem.video_name || queueItem.torrent_id || 'Unknown';
      logger.info(`Processing video: ${videoName}`);

      // Get output directory early so we can clean it up even if processing fails
      const outputDir = this.getOutputDir(queueItem.id!);

      try {
        // Step 2: Get download URL from TorBox
        if (!queueItem.torrent_id || !queueItem.file_id) {
          throw new Error('torrent_id and file_id are required to process video');
        }

        logger.info(
          `Fetching download URL from TorBox for torrent_id: ${queueItem.torrent_id}, file_id: ${queueItem.file_id}`
        );
        const torboxStartTime = Date.now();
        const videoUrl = await this.torboxService.requestDownloadUrl(
          queueItem.torrent_id,
          queueItem.file_id
        );
        timingBreakdown['torbox_url_fetch'] = Date.now() - torboxStartTime;
        logger.info(`Successfully retrieved download URL from TorBox: ${videoUrl}`);

        // Step 3: Process the video with the URL from TorBox
        const videoProcessingStartTime = Date.now();
        await this.videoProcessor.processVideo(videoUrl, queueItem.id!);
        timingBreakdown['video_processing'] = Date.now() - videoProcessingStartTime;

        // Step 4: Upload processed files to TikTok
        logger.info('Starting TikTok upload process...');
        const tiktokUploadStartTime = Date.now();
        const tiktokPlaylistUrl =
          await this.tiktokUploadOrchestrator.uploadProcessedFiles(outputDir);
        timingBreakdown['tiktok_upload'] = Date.now() - tiktokUploadStartTime;

        // Step 5: Create video record in videos table only after successful processing
        const dbCreateStartTime = Date.now();
        const video = await this.videoService.createVideo({
          video_path: videoUrl,
          video_name: queueItem.video_name ?? null,
          video_description: queueItem.video_description ?? null,
          release_date: queueItem.release_date ?? null,
          thumbnail_url: queueItem.thumbnail_url ?? null,
          actresses: queueItem.actresses ?? null,
          video_network: queueItem.video_network ?? null,
          id: queueItem.id,
        });
        timingBreakdown['database_create'] = Date.now() - dbCreateStartTime;

        // Step 6: Update video status to ready with TikTok playlist URL
        const dbUpdateStartTime = Date.now();
        await this.videoService.updateVideoStatus(video.id!, 'ready', tiktokPlaylistUrl);
        timingBreakdown['database_update'] = Date.now() - dbUpdateStartTime;

        // Step 7: Submit video to IndexNow for indexing
        const indexNowStartTime = Date.now();
        if (video.id) {
          await this.indexNowService.submitVideo(video.id);
        }
        timingBreakdown['indexnow_submission'] = Date.now() - indexNowStartTime;

        // Step 8: Update queue item status to processed
        const queueUpdateStartTime = Date.now();
        await this.queueService.updateStatus(queueItem.id!, 'processed', 100);
        timingBreakdown['queue_update'] = Date.now() - queueUpdateStartTime;

        // Step 9: Clean up output folder after successful processing
        const cleanupStartTime = Date.now();
        await this.cleanupOutputFolder(outputDir);
        timingBreakdown['cleanup'] = Date.now() - cleanupStartTime;

        // Calculate total processing time
        const totalProcessingTime = Date.now() - processingStartTime;
        const totalSeconds = (totalProcessingTime / 1000).toFixed(2);
        const totalMinutes = (totalProcessingTime / 60000).toFixed(2);

        // Format timing breakdown for logging
        const timingDetails = Object.entries(timingBreakdown)
          .map(([step, ms]) => {
            const seconds = (ms / 1000).toFixed(2);
            const percentage = ((ms / totalProcessingTime) * 100).toFixed(1);
            return `  ${step}: ${seconds}s (${percentage}%)`;
          })
          .join('\n');

        logger.info(
          `✅ Video processing and TikTok upload completed successfully: ${videoName}\n` +
            `⏱️ Total processing time: ${totalSeconds}s (${totalMinutes} minutes)\n` +
            `📊 Timing breakdown:\n${timingDetails}`
        );
      } catch (processingError) {
        const totalProcessingTime = Date.now() - processingStartTime;
        const totalSeconds = (totalProcessingTime / 1000).toFixed(2);
        const videoName = queueItem.video_name || queueItem.torrent_id || 'Unknown';

        logger.error(
          `❌ Video processing failed: ${videoName} (Failed after ${totalSeconds}s)`,
          processingError
        );

        // Log timing breakdown even on failure
        if (Object.keys(timingBreakdown).length > 0) {
          const timingDetails = Object.entries(timingBreakdown)
            .map(([step, ms]) => {
              const seconds = (ms / 1000).toFixed(2);
              const percentage = ((ms / totalProcessingTime) * 100).toFixed(1);
              return `  ${step}: ${seconds}s (${percentage}%)`;
            })
            .join('\n');
          logger.error(`⏱️ Processing time before failure:\n${timingDetails}`);
        }

        // Update queue item status to failed
        await this.queueService.updateStatus(queueItem.id!, 'failed', 0);

        // Clean up processed folder on failure to prevent disk space issues
        await this.cleanupOutputFolder(outputDir);

        throw processingError;
      }
    } catch (error) {
      logger.error('Video processing pipeline failed:', error);
      throw error;
    }
  }

  /**
   * Gets the output directory for processed files
   * @param queueItemId - Queue item ID
   * @returns Absolute output directory path
   */
  private getOutputDir(queueItemId: string): string {
    // Always use current working directory since we're using TorBox URLs
    return path.join(process.cwd(), 'processed', queueItemId);
  }

  /**
   * Cleans up the output folder after processing (success or failure)
   * @param outputDir - Directory to clean up
   */
  private async cleanupOutputFolder(outputDir: string): Promise<void> {
    try {
      // Check if directory exists before attempting to remove it
      try {
        await fs.access(outputDir);
      } catch {
        // Directory doesn't exist, nothing to clean up
        logger.debug(`Output folder does not exist, skipping cleanup: ${outputDir}`);
        return;
      }

      await fs.rm(outputDir, { recursive: true, force: true });
      logger.info(`✅ Successfully cleaned up output folder: ${outputDir}`);
    } catch (error) {
      logger.warn(`⚠️ Failed to clean up output folder ${outputDir}:`, error);
      // Don't throw error as cleanup failure shouldn't fail the entire process
    }
  }
}
