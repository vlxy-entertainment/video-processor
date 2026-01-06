import { supabase } from '@/config/supabase';
import { logger } from '@/utils/logger';
import { Video, VideoSchema } from '@/types';

/**
 * Service for managing video operations in Supabase
 */
export class VideoService {
  private readonly videosTable = 'videos';
  private readonly actressesTable = 'actresses';
  private readonly videoActressesTable = 'video_actresses';
  private readonly videoNetworksTable = 'video_networks';

  /**
   * Creates a new video record
   * @param queueItem - The queue item to create video from
   * @returns Promise that resolves to the created video record
   */
  async createVideo(queueItem: {
    video_path: string;
    video_name?: string | null;
    video_description?: string | null;
    release_date?: string | null;
    thumbnail_url?: string | null;
    actresses?: string | null;
    video_network?: string | null;
    id: string;
  }): Promise<Video> {
    try {
      // Use video_name from queue item if available, otherwise fall back to filename
      const videoTitle = queueItem.video_name || queueItem.video_path.split('/').pop() || 'unknown';
      // Use video_description from queue item if available, otherwise generate a default description
      const videoDescription =
        queueItem.video_description ||
        (queueItem.video_name
          ? `Video: ${queueItem.video_name}`
          : `Video file: ${queueItem.video_path.split('/').pop() || 'unknown'}`);

      // Find or create video network
      let videoNetworkId: string | null = null;
      if (queueItem.video_network) {
        videoNetworkId = await this.findOrCreateNetwork(queueItem.video_network);
      }

      const videoRecord: Omit<Video, 'id' | 'created_at' | 'updated_at'> = {
        title: videoTitle,
        description: videoDescription,
        status: 'ready', // Set to ready since we only create video records after successful processing
        thumbnail_url: queueItem.thumbnail_url || null,
        release_date: queueItem.release_date || null,
        video_network_id: videoNetworkId,
      };

      const { data, error } = await supabase
        .from(this.videosTable)
        .insert([videoRecord])
        .select()
        .single();

      if (error) {
        logger.error('Failed to create video record:', error);
        throw new Error(`Failed to create video record: ${error.message}`);
      }

      const video = VideoSchema.parse(data);

      // Assign actresses to video
      if (queueItem.actresses && video.id) {
        await this.assignActressesToVideo(video.id, queueItem.actresses);
      }

      logger.info(`Created video record for: ${videoTitle}`);
      return video;
    } catch (error) {
      logger.error(`Error creating video record:`, error);
      throw error;
    }
  }

  /**
   * Finds or creates a video network by name
   * @param networkName - Name of the network
   * @returns Promise that resolves to the network ID
   */
  private async findOrCreateNetwork(networkName: string): Promise<string> {
    try {
      // Try to find existing network
      const { data: existingNetwork, error: findError } = await supabase
        .from(this.videoNetworksTable)
        .select('id')
        .eq('name', networkName)
        .single();

      if (findError && findError.code !== 'PGRST116') {
        // PGRST116 is "not found" error, which is expected
        logger.error('Failed to find network:', findError);
        throw new Error(`Failed to find network: ${findError.message}`);
      }

      if (existingNetwork) {
        logger.debug(`Found existing network: ${networkName} (${existingNetwork.id})`);
        return existingNetwork.id;
      }

      // Create new network if not found
      const { data: newNetwork, error: createError } = await supabase
        .from(this.videoNetworksTable)
        .insert([{ name: networkName }])
        .select('id')
        .single();

      if (createError) {
        logger.error('Failed to create network:', createError);
        throw new Error(`Failed to create network: ${createError.message}`);
      }

      logger.info(`Created new network: ${networkName} (${newNetwork.id})`);
      return newNetwork.id;
    } catch (error) {
      logger.error(`Error finding or creating network:`, error);
      throw error;
    }
  }

  /**
   * Assigns actresses to a video by parsing comma-separated actress names
   * @param videoId - Video ID
   * @param actressesString - Comma-separated string of actress names
   */
  private async assignActressesToVideo(videoId: string, actressesString: string): Promise<void> {
    try {
      // Parse comma-separated actress names
      const actressNames = actressesString
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0);

      if (actressNames.length === 0) {
        logger.debug('No actresses to assign');
        return;
      }

      logger.info(`Assigning ${actressNames.length} actresses to video ${videoId}`);

      // Find or create actresses and collect their IDs
      const actressIds: string[] = [];
      for (const actressName of actressNames) {
        const actressId = await this.findOrCreateActress(actressName);
        actressIds.push(actressId);
      }

      // Create video_actresses relationships
      const videoActressesInserts = actressIds.map(actressId => ({
        video_id: videoId,
        actress_id: actressId,
      }));

      const { error: assignError } = await supabase
        .from(this.videoActressesTable)
        .insert(videoActressesInserts);

      if (assignError) {
        logger.error('Failed to assign actresses to video:', assignError);
        throw new Error(`Failed to assign actresses to video: ${assignError.message}`);
      }

      logger.info(`Successfully assigned ${actressIds.length} actresses to video ${videoId}`);
    } catch (error) {
      logger.error(`Error assigning actresses to video:`, error);
      throw error;
    }
  }

  /**
   * Finds or creates an actress by name
   * @param actressName - Name of the actress
   * @returns Promise that resolves to the actress ID
   */
  private async findOrCreateActress(actressName: string): Promise<string> {
    try {
      // Try to find existing actress
      const { data: existingActress, error: findError } = await supabase
        .from(this.actressesTable)
        .select('id')
        .eq('name', actressName)
        .single();

      if (findError && findError.code !== 'PGRST116') {
        // PGRST116 is "not found" error, which is expected
        logger.error('Failed to find actress:', findError);
        throw new Error(`Failed to find actress: ${findError.message}`);
      }

      if (existingActress) {
        logger.debug(`Found existing actress: ${actressName} (${existingActress.id})`);
        return existingActress.id;
      }

      // Create new actress if not found
      const { data: newActress, error: createError } = await supabase
        .from(this.actressesTable)
        .insert([{ name: actressName }])
        .select('id')
        .single();

      if (createError) {
        logger.error('Failed to create actress:', createError);
        throw new Error(`Failed to create actress: ${createError.message}`);
      }

      logger.info(`Created new actress: ${actressName} (${newActress.id})`);
      return newActress.id;
    } catch (error) {
      logger.error(`Error finding or creating actress:`, error);
      throw error;
    }
  }

  /**
   * Updates video status
   * @param id - Video ID
   * @param status - New status
   * @param hlsPlaylistUrl - Optional HLS playlist URL
   * @returns Promise that resolves to the updated video record
   */
  async updateVideoStatus(
    id: string,
    status: Video['status'],
    hlsPlaylistUrl?: string
  ): Promise<Video> {
    try {
      const updateData: Partial<Video> = {
        status,
        updated_at: new Date().toISOString(),
      };

      if (hlsPlaylistUrl) {
        updateData.hls_playlist_url = hlsPlaylistUrl;
      }

      const { data, error } = await supabase
        .from(this.videosTable)
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        logger.error('Failed to update video status:', error);
        throw new Error(`Failed to update video status: ${error.message}`);
      }

      logger.info(`Updated video ${id} status to ${status}`);
      return VideoSchema.parse(data);
    } catch (error) {
      logger.error(`Error updating video status:`, error);
      throw error;
    }
  }

  /**
   * Gets a video by ID
   * @param id - Video ID
   * @returns Promise that resolves to the video record
   */
  async getVideo(id: string): Promise<Video | null> {
    try {
      const { data, error } = await supabase
        .from(this.videosTable)
        .select('*')
        .eq('id', id)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return null; // Not found
        }
        logger.error('Failed to get video:', error);
        throw new Error(`Failed to get video: ${error.message}`);
      }

      return VideoSchema.parse(data);
    } catch (error) {
      logger.error(`Error getting video:`, error);
      throw error;
    }
  }
}
