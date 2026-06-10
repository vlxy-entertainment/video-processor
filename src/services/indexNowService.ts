import axios, { AxiosError } from 'axios';
import { logger } from '@/utils/logger';

/**
 * Service for submitting URLs to IndexNow API
 */
export class IndexNowService {
  private readonly apiEndpoint = 'https://api.indexnow.org/IndexNow';
  private readonly host: string;
  private readonly key: string;
  private readonly keyLocation: string;

  constructor() {
    // IndexNow configuration from environment variables
    this.host = process.env.INDEXNOW_HOST || 'vlxy.org';
    this.key = process.env.INDEXNOW_KEY || '9633d3f0c7a6463fb08566f7959e0c7d';
    this.keyLocation = process.env.INDEXNOW_KEY_LOCATION || `https://${this.host}/${this.key}.txt`;
  }

  /**
   * Submits a video URL to IndexNow for indexing
   * @param videoId - The video UUID
   * @returns Promise that resolves when submission is complete
   */
  async submitVideo(videoId: string): Promise<void> {
    try {
      const videoUrl = `https://${this.host}/video/${videoId}`;

      logger.info(`Submitting video URL to IndexNow: ${videoUrl}`);

      const requestBody = {
        host: this.host,
        key: this.key,
        keyLocation: this.keyLocation,
        urlList: [videoUrl],
      };

      const response = await axios.post(this.apiEndpoint, requestBody, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000, // 10 second timeout
      });

      // IndexNow returns 200 OK for successful submissions
      // 202 Accepted means the request was accepted but processing is asynchronous
      if (response.status === 200 || response.status === 202) {
        logger.info(`✅ Successfully submitted video ${videoId} to IndexNow`);
      } else {
        logger.warn(
          `⚠️ IndexNow returned unexpected status ${response.status} for video ${videoId}`
        );
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      const errorMessage = axiosError.response?.data || axiosError.message || 'Unknown error';

      // Log error but don't throw - IndexNow submission failure shouldn't fail video processing
      logger.error(`Failed to submit video ${videoId} to IndexNow:`, {
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        error: errorMessage,
      });
    }
  }

  /**
   * Submits multiple video URLs to IndexNow
   * @param videoIds - Array of video UUIDs
   * @returns Promise that resolves when all submissions are complete
   */
  async submitVideos(videoIds: string[]): Promise<void> {
    if (videoIds.length === 0) {
      return;
    }

    logger.info(`Submitting ${videoIds.length} video URLs to IndexNow`);

    const videoUrls = videoIds.map(videoId => `https://${this.host}/video/${videoId}`);

    try {
      const requestBody = {
        host: this.host,
        key: this.key,
        keyLocation: this.keyLocation,
        urlList: videoUrls,
      };

      const response = await axios.post(this.apiEndpoint, requestBody, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000, // 10 second timeout
      });

      if (response.status === 200 || response.status === 202) {
        logger.info(`✅ Successfully submitted ${videoIds.length} videos to IndexNow`);
      } else {
        logger.warn(
          `⚠️ IndexNow returned unexpected status ${response.status} for ${videoIds.length} videos`
        );
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      const errorMessage = axiosError.response?.data || axiosError.message || 'Unknown error';

      logger.error(`Failed to submit ${videoIds.length} videos to IndexNow:`, {
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        error: errorMessage,
      });
    }
  }
}
