import { TorboxApi } from '@torbox/torbox-api';
import { logger } from '@/utils/logger';
import { envConfig } from '@/config';

/**
 * Service for interacting with TorBox API to fetch download URLs
 */
export class TorboxService {
  private readonly torboxApi: TorboxApi;

  constructor() {
    this.torboxApi = new TorboxApi({
      token: envConfig.TORBOX_TOKEN,
      validation: {
        responseValidation: false,
      },
    });
  }

  /**
   * Requests a download URL from TorBox using torrent_id and file_id
   * @param torrentId - The torrent ID from TorBox
   * @param fileId - The file ID from TorBox
   * @returns Promise that resolves to the download URL
   * @throws Error if the download URL cannot be fetched
   */
  async requestDownloadUrl(torrentId: string, fileId: string): Promise<string> {
    try {
      logger.info(
        `Requesting download URL from TorBox for torrent_id: ${torrentId}, file_id: ${fileId}`
      );

      const url = await this.torboxApi.torrents.requestDownloadLink('v1', {
        fileId: fileId,
        torrentId: torrentId,
        token: envConfig.TORBOX_TOKEN,
      });

      if (!url.data) {
        throw new Error('TorBox API returned no data');
      }

      if (url.data.error) {
        throw new Error(`TorBox API error: ${url.data.error}`);
      }

      if (!url.data.data) {
        throw new Error('TorBox API returned no download URL');
      }

      logger.info(`Successfully retrieved download URL from TorBox`);
      return url.data.data;
    } catch (error) {
      logger.error('Failed to request download URL from TorBox:', error);
      throw new Error(
        `Failed to request download URL from TorBox: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
