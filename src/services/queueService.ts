import { supabase } from '@/config/supabase';
import { logger } from '@/utils/logger';
import { VideoProcessingQueueItem, VideoProcessingQueueItemSchema } from '@/types';

/**
 * Service for managing video processing queue operations in Supabase
 * Uses dedicated 'video_processing_queue' table
 */
export class QueueService {
  private readonly queueTable = 'video_processing_queue';

  /**
   * Adds a video to the queue with torrent information
   * @param videoName - Optional name for the video (used for title/description)
   * @param torrentId - Torrent ID from TorBox
   * @param fileId - File ID from TorBox
   * @returns Promise that resolves to the created queue item
   * @throws Error if the operation fails
   */
  async addToQueue(
    videoName?: string,
    torrentId?: string,
    fileId?: string
  ): Promise<VideoProcessingQueueItem> {
    try {
      // Get the next index for the queue
      const nextIndex = await this.getNextIndex();

      const queueItem: Omit<VideoProcessingQueueItem, 'id' | 'created_at' | 'updated_at'> = {
        index: nextIndex,
        status: 'queued',
        progress: 0,
        video_name: videoName || null,
        torrent_id: torrentId || null,
        file_id: fileId || null,
      };

      const { data, error } = await supabase
        .from(this.queueTable)
        .insert([queueItem])
        .select()
        .single();

      if (error) {
        logger.error('Failed to add video to queue:', error);
        throw new Error(`Failed to add video to queue: ${error.message}`);
      }

      logger.info(`Successfully added video to queue at index ${nextIndex}`);
      return VideoProcessingQueueItemSchema.parse(data);
    } catch (error) {
      logger.error('Error adding video to queue:', error);
      throw error;
    }
  }

  /**
   * Gets all items in the queue
   * @returns Promise that resolves to an array of queue items
   * @throws Error if the operation fails
   */
  async getQueue(): Promise<VideoProcessingQueueItem[]> {
    try {
      const { data, error } = await supabase
        .from(this.queueTable)
        .select('*')
        .order('index', { ascending: true });

      if (error) {
        logger.error('Failed to get queue:', error);
        throw new Error(`Failed to get queue: ${error.message}`);
      }

      return data.map(item => VideoProcessingQueueItemSchema.parse(item));
    } catch (error) {
      logger.error('Error getting queue:', error);
      throw error;
    }
  }

  /**
   * Gets the current queue and logs it
   * @returns Promise that resolves to the queue items
   */
  async logCurrentQueue(): Promise<VideoProcessingQueueItem[]> {
    try {
      const queue = await this.getQueue();

      logger.info('Current queue status:', {
        totalItems: queue.length,
        items: queue.map(item => ({
          id: item.id,
          videoName: item.video_name,
          torrentId: item.torrent_id,
          fileId: item.file_id,
          index: item.index,
          status: item.status,
          progress: item.progress,
          createdAt: item.created_at,
        })),
      });

      return queue;
    } catch (error) {
      logger.error('Error logging current queue:', error);
      throw error;
    }
  }

  /**
   * Checks if a torrent is already in the queue
   * @param torrentId - Torrent ID from TorBox
   * @param fileId - File ID from TorBox
   * @returns Promise that resolves to true if torrent exists in queue
   */
  async isTorrentInQueue(torrentId: string, fileId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from(this.queueTable)
        .select('id')
        .eq('torrent_id', torrentId)
        .eq('file_id', fileId)
        .limit(1);

      if (error) {
        logger.error('Failed to check if torrent is in queue:', error);
        return false;
      }

      return data && data.length > 0;
    } catch (error) {
      logger.error('Error checking if torrent is in queue:', error);
      return false;
    }
  }

  /**
   * Gets the next index for the queue
   * @returns Promise that resolves to the next index number
   */
  private async getNextIndex(): Promise<number> {
    try {
      const { data, error } = await supabase
        .from(this.queueTable)
        .select('index')
        .order('index', { ascending: false })
        .limit(1);

      if (error) {
        logger.error('Failed to get next index:', error);
        return 0; // Start from 0 if no items exist
      }

      if (!data || data.length === 0) {
        return 0; // First item in queue
      }

      return data[0].index + 1;
    } catch (error) {
      logger.error('Error getting next index:', error);
      return 0;
    }
  }

  /**
   * Gets the next item in the queue that has 'queued' status and atomically updates it to 'processing'
   * Uses database-level locking to prevent race conditions
   * @returns Promise that resolves to the next queue item or null if none available
   */
  async getNextItem(): Promise<VideoProcessingQueueItem | null> {
    try {
      // Check if there's already a video being processed
      const { data: processingItem, error: processingError } = await supabase
        .from(this.queueTable)
        .select('id')
        .eq('status', 'processing')
        .limit(1);

      if (processingError) {
        logger.error('Failed to check for processing items:', processingError);
        return null;
      }

      if (processingItem && processingItem.length > 0) {
        logger.info('Video is already being processed, skipping queue');
        return null;
      }

      // Get the first item with 'queued' status
      const { data: queueItems, error: selectError } = await supabase
        .from(this.queueTable)
        .select('*')
        .eq('status', 'queued')
        .order('index', { ascending: true })
        .limit(1);

      if (selectError) {
        logger.error('Failed to get next queue item:', selectError);
        return null;
      }

      if (!queueItems || queueItems.length === 0) {
        logger.info('No items in queue with queued status');
        return null;
      }

      const item = VideoProcessingQueueItemSchema.parse(queueItems[0]);

      // Atomically update the status to 'processing' to prevent race conditions
      // This ensures only one instance can claim a video for processing
      const { data: updatedData, error: updateError } = await supabase
        .from(this.queueTable)
        .update({
          status: 'processing',
          progress: 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id)
        .eq('status', 'queued') // Only update if still queued (prevents race condition)
        .select()
        .single();

      if (updateError) {
        logger.error('Failed to atomically claim queue item:', updateError);
        return null;
      }

      if (!updatedData) {
        // Another instance already claimed this item
        logger.info(`Queue item ${item.id} was already claimed by another instance`);
        return null;
      }

      return VideoProcessingQueueItemSchema.parse(updatedData);
    } catch (error) {
      logger.error('Error getting next queue item:', error);
      return null;
    }
  }

  /**
   * Updates the status and progress of a queue item
   * @param id - ID of the queue item
   * @param status - New status
   * @param progress - New progress (0-100)
   * @returns Promise that resolves to the updated queue item
   */
  async updateStatus(
    id: string,
    status: VideoProcessingQueueItem['status'],
    progress: number = 0
  ): Promise<VideoProcessingQueueItem> {
    try {
      const { data, error } = await supabase
        .from(this.queueTable)
        .update({
          status,
          progress,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        logger.error('Failed to update queue item status:', error);
        throw new Error(`Failed to update status: ${error.message}`);
      }

      logger.info(`Updated queue item ${id} status to ${status} with progress ${progress}%`);
      return VideoProcessingQueueItemSchema.parse(data);
    } catch (error) {
      logger.error(`Error updating queue item ${id} status:`, error);
      throw error;
    }
  }

  /**
   * Removes an item from the queue
   * @param id - ID of the queue item to remove
   * @returns Promise that resolves when the item is removed
   */
  async removeFromQueue(id: string): Promise<void> {
    try {
      const { error } = await supabase.from(this.queueTable).delete().eq('id', id);

      if (error) {
        logger.error('Failed to remove item from queue:', error);
        throw new Error(`Failed to remove item: ${error.message}`);
      }

      logger.info(`Successfully removed item ${id} from queue`);
    } catch (error) {
      logger.error(`Error removing item ${id} from queue:`, error);
      throw error;
    }
  }
}
