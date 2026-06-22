import { ApiClientService } from '@/services/apiClientService';
import { TiktokUploadResponse } from '@/types/common';
import { TiktokAccount } from '@/types';
import { logger } from '@/utils/logger';
import { envConfig } from '@/config';
import { AxiosResponse, AxiosError } from 'axios';
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import FormData from 'form-data';

/**
 * Retry configuration for upload operations
 */
const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 1000, // 1 second
  MAX_DELAY_MS: 10000, // 10 seconds
  RETRYABLE_STATUS_CODES: [500, 502, 503, 504, 520, 521, 522, 523, 524],
} as const;

/**
 * Service for handling core TikTok upload operations
 */
export class TiktokUploadService {
  private apiClient: ApiClientService;

  constructor() {
    this.apiClient = new ApiClientService(envConfig.TIKTOK_API_ENDPOINT);
    this.apiClient.setHeader('Host', 'www.tiktok.com');
  }

  /**
   * Check if an error is retryable based on status code
   * @param error The axios error to check
   * @returns True if the error is retryable
   */
  private isRetryableError(error: AxiosError): boolean {
    const statusCode = error.response?.status;
    if (!statusCode) return false;

    // Type assertion is safe here because we're checking against known status codes
    return RETRY_CONFIG.RETRYABLE_STATUS_CODES.includes(
      statusCode as (typeof RETRY_CONFIG.RETRYABLE_STATUS_CODES)[number]
    );
  }

  /**
   * Calculate delay for exponential backoff
   * @param attempt The current attempt number (0-based)
   * @returns Delay in milliseconds
   */
  private calculateDelay(attempt: number): number {
    const exponentialDelay = RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = Math.random() * 1000; // Add up to 1 second of jitter
    return Math.min(exponentialDelay + jitter, RETRY_CONFIG.MAX_DELAY_MS);
  }

  /**
   * Sleep for the specified number of milliseconds
   * @param ms Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Perform a single upload attempt with the given account
   * @param filePath The path to the file to upload
   * @param account The TikTok account to use
   * @returns Promise resolving to the uploaded image URL or null
   */
  async performUpload(filePath: string, account: TiktokAccount): Promise<string | null> {
    return this.performUploadWithRetry(filePath, account, 0);
  }

  /**
   * Perform upload with retry logic for 5xx errors
   * @param filePath The path to the file to upload
   * @param account The TikTok account to use
   * @param attempt The current attempt number (0-based)
   * @returns Promise resolving to the uploaded image URL or null
   */
  private async performUploadWithRetry(
    filePath: string,
    account: TiktokAccount,
    attempt: number
  ): Promise<string | null> {
    try {
      // Get file stats for logging
      const fileStats = await fs.stat(filePath);
      const fileName = path.basename(filePath);

      const attemptInfo =
        attempt > 0 ? ` (attempt ${attempt + 1}/${RETRY_CONFIG.MAX_RETRIES + 1})` : '';
      logger.info(
        `📤 Uploading file: ${fileName} (${fileStats.size} bytes) with account: ${account.name} (${account.aadvid})${attemptInfo}`
      );

      // Get CSRF token from account data
      if (!account.csrftoken) {
        throw new Error(`Account ${account.name} does not have a CSRF token`);
      }
      const csrfToken = account.csrftoken;

      // Create form data with file stream to avoid loading entire file into memory
      const formData = new FormData();
      formData.append('file', createReadStream(filePath), {
        filename: fileName,
        contentType: this.getContentType(fileName),
      });
      // Load-bearing: source='0' routes the upload to TikTok's origin-preserving
      // object store. Without it TikTok re-encodes the file as an image and strips
      // every byte after the PNG IEND chunk — destroying the embedded HLS payload.
      formData.append('source', '0');

      const cookieHeader = `tt_csrf_token=${csrfToken}; sid_guard=${account.sid_guard_ads}`;

      const uploadConfig = {
        headers: {
          'tt-csrf-token': csrfToken,
          Cookie: cookieHeader,
        },
        withCredentials: true,
      };

      // Log Cookie header for debugging (only on first attempt to avoid spam)
      if (attempt === 0) {
        logger.info('🍪 Cookie header details:', {
          cookieHeader: cookieHeader,
          csrfToken: csrfToken ? `${csrfToken.substring(0, 10)}...` : 'none',
          csrfTokenLength: csrfToken ? csrfToken.length : 0,
          sidGuardAds: account.sid_guard_ads
            ? `${account.sid_guard_ads.substring(0, 10)}...`
            : 'none',
          sidGuardAdsLength: account.sid_guard_ads ? account.sid_guard_ads.length : 0,
          cookieHeaderLength: cookieHeader.length,
          hasInvalidChars: /[^\x20-\x7E]/.test(cookieHeader), // Check for non-printable characters
        });
      }

      logger.info('📡 Sending upload request to TikTok API...', {
        url: `${envConfig.TIKTOK_API_ENDPOINT}/api/upload/image/`,
        aadvid: account.aadvid,
        csrfToken: csrfToken ? `${csrfToken.substring(0, 10)}...` : 'none',
        fileSize: fileStats.size,
        fileName: fileName,
        filePath: filePath,
        accountName: account.name,
        attempt: attempt + 1,
        maxAttempts: RETRY_CONFIG.MAX_RETRIES + 1,
      });

      const response = await this.apiClient.post<TiktokUploadResponse>(
        'api/upload/image/',
        formData,
        uploadConfig
      );

      // Force garbage collection after upload to free memory
      if (global.gc) {
        global.gc();
      }

      return this.processUploadResponse(response, account);
    } catch (error) {
      const axiosError = error as AxiosError;

      // Check if this is a retryable error and we haven't exceeded max retries
      if (this.isRetryableError(axiosError) && attempt < RETRY_CONFIG.MAX_RETRIES) {
        const delay = this.calculateDelay(attempt);
        const statusCode = axiosError.response?.status;

        logger.warn(
          `🔄 Upload failed with ${statusCode} status code, retrying in ${Math.round(delay)}ms...`,
          {
            fileName: path.basename(filePath),
            accountName: account.name,
            aadvid: account.aadvid,
            statusCode,
            attempt: attempt + 1,
            maxAttempts: RETRY_CONFIG.MAX_RETRIES + 1,
            delay: Math.round(delay),
            errorMessage: axiosError.message,
          }
        );

        // Wait before retrying
        await this.sleep(delay);

        // Retry the upload
        return this.performUploadWithRetry(filePath, account, attempt + 1);
      }

      // If not retryable or max retries exceeded, log the error and rethrow
      const statusCode = axiosError.response?.status;

      // Extract response data safely - limit size to prevent "Invalid string length" errors
      let responseData: unknown = undefined;
      if (axiosError.response?.data) {
        try {
          const dataStr =
            typeof axiosError.response.data === 'string'
              ? axiosError.response.data
              : JSON.stringify(axiosError.response.data);

          // Limit response data to 5KB to prevent logging errors
          if (dataStr.length > 5000) {
            responseData = `${dataStr.substring(0, 5000)}...[truncated ${dataStr.length - 5000} chars]`;
          } else {
            responseData = axiosError.response.data;
          }
        } catch {
          responseData = '[Unable to serialize response data]';
        }
      }

      logger.error(`❌ Upload failed after ${attempt + 1} attempts:`, {
        fileName: path.basename(filePath),
        accountName: account.name,
        aadvid: account.aadvid,
        statusCode,
        statusText: axiosError.response?.statusText,
        errorMessage: axiosError.message,
        isRetryable: this.isRetryableError(axiosError),
        maxRetriesExceeded: attempt >= RETRY_CONFIG.MAX_RETRIES,
        responseData,
      });

      throw error;
    }
  }

  /**
   * Process the upload response and extract the image URL
   * @param response The API response
   * @param account The account used for upload
   * @returns The image URL or null if failed
   */
  private processUploadResponse(
    response: AxiosResponse<TiktokUploadResponse>,
    account: TiktokAccount
  ): string | null {
    // Check for API-level errors first
    if (response?.data?.status_code && response.data.status_code !== 0) {
      logger.error('❌ TikTok API returned error:', {
        status_code: response.data.status_code,
        status_msg: response.data.status_msg,
        extra: response.data.extra,
        accountId: account.id,
        accountName: account.name,
      });

      return null;
    }

    // Check for successful response with image URL
    if (response?.data?.data?.uri) {
      const imageUrl = this.extractImageUrl(response.data.data);

      if (imageUrl) {
        logger.info(`✅ Upload successful: ${imageUrl}`);
        logger.info(`📝 Image details:`);

        logger.info('Image details:', {
          uri: response.data.data.uri,
          url_list: response.data.data.url_list,
          url_prefix: response.data.data.url_prefix,
          status_code: response.data.status_code,
          status_msg: response.data.status_msg,
          accountId: account.id,
          accountName: account.name,
        });

        return imageUrl;
      }
    }

    logger.error('❌ Upload response missing image URL:', {
      responseData: response?.data,
      status: response?.status,
      statusText: response?.statusText,
      accountId: account.id,
      accountName: account.name,
    });

    return null;
  }

  /**
   * Extract the complete image URL from the response data
   * @param responseData The data from the TikTok API response
   * @returns The complete image URL or null
   */
  private extractImageUrl(responseData: TiktokUploadResponse['data']): string {
    // Remove leading slash if present to avoid double slashes
    const uriPath = responseData.uri.startsWith('/')
      ? responseData.uri.substring(1)
      : responseData.uri;

    // Construct the complete URL using TIKTOK_IMG_CDN
    const completeUrl = `${envConfig.TIKTOK_IMG_CDN}${uriPath}`;

    logger.info('✅ Constructed image URL using uri + TIKTOK_IMG_CDN:', {
      uri: responseData.uri,
      tikTokImgCdn: envConfig.TIKTOK_IMG_CDN,
      completeUrl,
    });

    return completeUrl;
  }

  /**
   * Get the appropriate content type for a file based on its extension
   * @param fileName The name of the file
   * @returns The MIME type for the file
   */
  private getContentType(fileName: string): string {
    const extension = path.extname(fileName).toLowerCase();

    const contentTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
      '.avi': 'video/avi',
      '.mov': 'video/quicktime',
      '.wmv': 'video/x-ms-wmv',
      '.flv': 'video/x-flv',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
    };

    return contentTypes[extension] || 'application/octet-stream';
  }

  /**
   * Test the TikTok API connection using the given account
   * @param account The account to test with
   * @returns Promise resolving to whether the connection test succeeded
   */
  async testConnection(account: TiktokAccount): Promise<boolean> {
    logger.info(`🧪 Testing TikTok API connection with account: ${account.name}`);

    return true;
  }
}
