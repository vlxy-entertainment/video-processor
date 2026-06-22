import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '@/utils/logger';
import { envConfig } from '@/config';
import { TiktokAccountService } from '@/services/tiktokAccountService';
import { TiktokUploadService } from '@/services/tiktok/TiktokUploadService';
import { TiktokAccount } from '@/types';

/**
 * Interface for upload result
 */
interface UploadResult {
  filePath: string;
  originalPath: string;
  uploadedUrl: string | null;
  success: boolean;
  accountId: string;
  error?: string;
}

/**
 * Interface for batch upload configuration
 */
interface BatchUploadConfig {
  batchSize: number;
  delayMs: number;
  outputDir: string;
}

/**
 * Retry configuration for failed uploads
 */
interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Service for orchestrating TikTok uploads with batch processing and account distribution
 */
export class TiktokUploadOrchestrator {
  private readonly accountService: TiktokAccountService;
  private readonly uploadService: TiktokUploadService;
  private readonly retryConfig: RetryConfig = {
    maxRetries: 3,
    initialDelayMs: 2000, // 2 seconds
    maxDelayMs: 30000, // 30 seconds
    backoffMultiplier: 2,
  };

  constructor() {
    this.accountService = new TiktokAccountService();
    this.uploadService = new TiktokUploadService();
  }

  /**
   * Checks if an error indicates rate limiting (403 status code)
   * @param error - The error to check
   * @returns True if the error indicates rate limiting
   */
  private isRateLimitedError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as { response?: { status?: number } };
      return axiosError.response?.status === 403;
    }
    return false;
  }

  /**
   * Uploads all processed video files (segments + playlist) to TikTok
   * @param outputDir - Directory containing processed files
   * @returns Promise that resolves to the uploaded playlist URL
   */
  async uploadProcessedFiles(outputDir: string): Promise<string> {
    logger.info(`Starting TikTok upload orchestration for: ${outputDir}`);

    // Step 1: Get active TikTok accounts
    const activeAccounts = await this.accountService.getActiveAccounts();
    if (activeAccounts.length === 0) {
      throw new Error('No active TikTok accounts available for upload');
    }

    logger.info(`Found ${activeAccounts.length} active TikTok accounts for upload distribution`);

    // Batch size scales with the account pool so each active account handles a
    // fixed number of uploads per batch (TIKTOK_ITEMS_PER_ACCOUNT), regardless of
    // how many accounts exist. activeAccounts.length is >= 1 (guarded above).
    const batchSize = activeAccounts.length * envConfig.TIKTOK_ITEMS_PER_ACCOUNT;
    const config: BatchUploadConfig = {
      batchSize,
      delayMs: envConfig.TIKTOK_BATCH_DELAY_MS,
      outputDir,
    };
    logger.info(
      `Batch size ${batchSize} = ${activeAccounts.length} active account(s) × ` +
        `${envConfig.TIKTOK_ITEMS_PER_ACCOUNT} items/account`
    );

    // Step 2: Get all files to upload
    const filesToUpload = await this.getFilesToUpload(outputDir);
    logger.info(`Found ${filesToUpload.length} files to upload`);

    // Step 3: Upload video segments in batches
    const segmentFiles = filesToUpload.filter(
      file => file.includes('segment_') && file.endsWith('.png')
    );
    let uploadResults = await this.uploadFilesInBatches(segmentFiles, activeAccounts, config);

    // Step 4: Retry failed uploads
    const failedUploads = uploadResults.filter(result => !result.success);
    if (failedUploads.length > 0) {
      logger.warn(`${failedUploads.length} segment uploads failed, attempting retries...`);
      const retryResults = await this.retryFailedUploads(failedUploads, activeAccounts);

      // Update upload results with retry results
      const retryMap = new Map(retryResults.map(result => [result.filePath, result]));
      uploadResults = uploadResults.map(result =>
        retryMap.has(result.filePath) ? retryMap.get(result.filePath)! : result
      );

      // Check if any uploads still failed after retries
      const stillFailed = uploadResults.filter(result => !result.success);
      if (stillFailed.length > 0) {
        logger.error(
          `${stillFailed.length} segment uploads failed after ${this.retryConfig.maxRetries} retries:`,
          stillFailed.map(f => ({ file: f.originalPath, error: f.error }))
        );
        throw new Error(
          `Failed to upload ${stillFailed.length} video segments to TikTok after retries`
        );
      } else {
        logger.info(`✅ All ${failedUploads.length} failed uploads succeeded after retries`);
      }
    }

    // Step 5: Update M3U8 playlist with uploaded URLs
    const playlistFile = filesToUpload.find(
      file => file.includes('playlist') && file.endsWith('.png')
    );
    if (!playlistFile) {
      throw new Error('M3U8 playlist file not found');
    }

    const updatedPlaylistPath = await this.updatePlaylistUrls(playlistFile, uploadResults);

    // Step 6: Upload the updated playlist
    const playlistUploadResult = await this.uploadSingleFile(
      updatedPlaylistPath,
      activeAccounts[0]
    );
    if (!playlistUploadResult.success || !playlistUploadResult.uploadedUrl) {
      throw new Error(`Failed to upload M3U8 playlist: ${playlistUploadResult.error}`);
    }

    logger.info(
      `✅ Successfully uploaded all files to TikTok. Playlist URL: ${playlistUploadResult.uploadedUrl}`
    );
    return playlistUploadResult.uploadedUrl;
  }

  /**
   * Gets all PNG files to upload from the output directory
   * @param outputDir - Directory to scan
   * @returns Array of file paths
   */
  private async getFilesToUpload(outputDir: string): Promise<string[]> {
    try {
      const files = await fs.readdir(outputDir);
      const pngFiles = files
        .filter(file => file.endsWith('.png'))
        .map(file => path.join(outputDir, file));

      return pngFiles.sort(); // Sort to ensure consistent order
    } catch (error) {
      logger.error(`Failed to read output directory ${outputDir}:`, error);
      throw new Error(`Failed to read output directory: ${error}`);
    }
  }

  /**
   * Uploads files in batches with account distribution
   * @param files - Array of file paths to upload
   * @param accounts - Available TikTok accounts
   * @param config - Batch upload configuration
   * @returns Array of upload results
   */
  private async uploadFilesInBatches(
    files: string[],
    accounts: TiktokAccount[],
    config: BatchUploadConfig
  ): Promise<UploadResult[]> {
    const results: UploadResult[] = [];
    const totalBatches = Math.ceil(files.length / config.batchSize);

    logger.info(
      `Uploading ${files.length} files in ${totalBatches} batches of ${config.batchSize}`
    );

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startIndex = batchIndex * config.batchSize;
      const endIndex = Math.min(startIndex + config.batchSize, files.length);
      const batchFiles = files.slice(startIndex, endIndex);

      logger.info(
        `Processing batch ${batchIndex + 1}/${totalBatches} (${batchFiles.length} files)`
      );

      // Process all files in batch concurrently and wait for all to complete
      const batchUploadPromises = batchFiles.map((filePath, fileIndex) => {
        const accountIndex = fileIndex % accounts.length;
        const account = accounts[accountIndex];

        return this.uploadSingleFile(filePath, account).catch(error => {
          logger.error(`Failed to upload file ${filePath}:`, error);
          return {
            filePath,
            originalPath: path.basename(filePath),
            uploadedUrl: null,
            success: false,
            accountId: account.id || 'unknown',
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        });
      });

      // Wait for all uploads in the batch to complete
      const batchResults = await Promise.all(batchUploadPromises);

      // Force garbage collection after batch completes to free memory
      if (global.gc) {
        global.gc();
      }

      results.push(...batchResults);

      // Log batch results
      const batchSuccesses = batchResults.filter(r => r.success).length;
      const batchFailures = batchResults.length - batchSuccesses;
      logger.info(
        `Batch ${batchIndex + 1} completed: ${batchSuccesses} success, ${batchFailures} failed`
      );

      // Log failures but continue processing - we'll retry failed uploads later
      if (batchFailures > 0) {
        const failedResults = batchResults.filter(r => !r.success);
        logger.warn(
          `Batch ${batchIndex + 1} had ${batchFailures} failed uploads (will retry later):`,
          failedResults.map(f => ({ file: f.originalPath, error: f.error }))
        );
      }

      // Delay before next batch (except for the last batch)
      if (batchIndex < totalBatches - 1) {
        logger.info(`Waiting ${config.delayMs}ms before next batch...`);
        await this.delay(config.delayMs);

        // Force garbage collection between batches
        if (global.gc) {
          global.gc();
        }
      }
    }

    return results;
  }

  /**
   * Uploads a single file to TikTok
   * @param filePath - Path to file to upload
   * @param account - TikTok account to use
   * @returns Upload result
   */
  private async uploadSingleFile(filePath: string, account: TiktokAccount): Promise<UploadResult> {
    const fileName = path.basename(filePath);

    try {
      logger.info(`Uploading ${fileName} using account: ${account.name}`);

      const uploadedUrl = await this.uploadService.performUpload(filePath, account);

      if (uploadedUrl && account.id) {
        // Update account statistics on successful upload
        await this.accountService.updateUploadStats(account.id);

        return {
          filePath,
          originalPath: fileName,
          uploadedUrl,
          success: true,
          accountId: account.id,
        };
      } else {
        return {
          filePath,
          originalPath: fileName,
          uploadedUrl: null,
          success: false,
          accountId: account.id || 'unknown',
          error: 'Upload returned null URL',
        };
      }
    } catch (error) {
      // Extract error message safely - the logger formatter will sanitize the error object
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Failed to upload file ${filePath}: ${errorMessage}`, { error });

      // Set account as limited only if TikTok API returns 403 (forbidden/rate limited)
      if (account.id && this.isRateLimitedError(error)) {
        try {
          await this.accountService.setAccountLimited(account.id);
          logger.warn(`Account ${account.name} marked as limited due to 403 response`);
        } catch (accountError) {
          const accountErrorMessage =
            accountError instanceof Error ? accountError.message : 'Unknown error';
          logger.error(`Failed to set account as limited: ${accountErrorMessage}`, {
            error: accountError,
          });
        }
      }

      return {
        filePath,
        originalPath: fileName,
        uploadedUrl: null,
        success: false,
        accountId: account.id || 'unknown',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Updates M3U8 playlist file with uploaded segment URLs
   * @param playlistPath - Path to the playlist PNG file
   * @param uploadResults - Results from segment uploads
   * @returns Path to the updated playlist file
   */
  private async updatePlaylistUrls(
    playlistPath: string,
    uploadResults: UploadResult[]
  ): Promise<string> {
    logger.info(`Updating playlist URLs in: ${path.basename(playlistPath)}`);

    try {
      // Read the PNG file and extract the M3U8 content
      const pngBuffer = await fs.readFile(playlistPath);
      const m3u8Content = await this.extractM3U8FromPNG(pngBuffer);

      // Create URL mapping from upload results
      // Map full filename (e.g., "segment_001.png") to uploaded URL
      const urlMapping = new Map<string, string>();
      uploadResults.forEach(result => {
        if (result.success && result.uploadedUrl) {
          // Use the full filename including .png extension for matching
          const segmentFilename = result.originalPath; // e.g., "segment_001.png"
          urlMapping.set(segmentFilename, result.uploadedUrl);
        }
      });

      // Replace segment filenames with uploaded URLs
      // Process line by line to ensure accurate replacement
      const lines = m3u8Content.split('\n');
      let replacementCount = 0;
      const updatedLines = lines.map(line => {
        // Only process lines that contain segment filenames (non-comment, non-empty lines)
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith('#')) {
          // This is a segment filename line
          // Extract just the filename from the line (in case there's a path)
          const lineFilename = path.basename(trimmedLine);

          // Try to match each segment filename and replace with its URL
          for (const [segmentFilename, uploadedUrl] of urlMapping.entries()) {
            // Match if the line contains the exact segment filename
            // Handle both cases: line is just the filename, or line contains path + filename
            if (lineFilename === segmentFilename || trimmedLine === segmentFilename) {
              // Replace the entire line with just the URL
              logger.debug(
                `Replacing segment reference: "${trimmedLine}" (${segmentFilename}) with URL: ${uploadedUrl}`
              );
              replacementCount++;
              return uploadedUrl;
            }
          }
        }
        // Return the line unchanged if no match found
        return line;
      });

      const updatedContent = updatedLines.join('\n');

      // Log mapping for debugging
      logger.info(
        `URL mapping created for ${urlMapping.size} segments, ${replacementCount} replacements made`
      );
      if (replacementCount !== urlMapping.size) {
        logger.warn(
          `⚠️ Warning: Expected ${urlMapping.size} replacements but made ${replacementCount}. Some segments may not have been replaced.`
        );
        // Log which segments were not replaced
        const replacedFilenames = new Set<string>();
        lines.forEach(line => {
          const trimmedLine = line.trim();
          if (trimmedLine && !trimmedLine.startsWith('#')) {
            const lineFilename = path.basename(trimmedLine);
            if (urlMapping.has(lineFilename)) {
              replacedFilenames.add(lineFilename);
            }
          }
        });
        urlMapping.forEach((url, filename) => {
          if (!replacedFilenames.has(filename)) {
            logger.warn(`  Missing replacement for: ${filename} -> ${url}`);
          }
        });
      }

      // Re-embed the updated M3U8 content back into the PNG file
      const updatedPlaylistPath = await this.embedM3U8IntoPNG(
        pngBuffer,
        updatedContent,
        playlistPath
      );

      logger.info(`Updated playlist embedded back into PNG: ${path.basename(updatedPlaylistPath)}`);
      return updatedPlaylistPath;
    } catch (error) {
      logger.error('Failed to update playlist URLs:', error);
      throw new Error(`Failed to update playlist URLs: ${error}`);
    }
  }

  /**
   * Extracts M3U8 content from a PNG file
   * @param pngBuffer - PNG file buffer
   * @returns M3U8 content as string
   */
  private async extractM3U8FromPNG(pngBuffer: Buffer): Promise<string> {
    // Find the end of PNG data (IEND chunk)
    const iendSignature = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const iendIndex = pngBuffer.indexOf(iendSignature);

    if (iendIndex === -1) {
      throw new Error('Invalid PNG file: IEND chunk not found');
    }

    // Extract M3U8 data after the IEND chunk
    const m3u8StartIndex = iendIndex + iendSignature.length;
    const m3u8Buffer = pngBuffer.slice(m3u8StartIndex);

    return m3u8Buffer.toString('utf8');
  }

  /**
   * Embeds updated M3U8 content back into a PNG file
   * @param originalPngBuffer - Original PNG file buffer
   * @param updatedM3U8Content - Updated M3U8 content to embed
   * @param originalPath - Original PNG file path
   * @returns Path to the updated PNG file
   */
  private async embedM3U8IntoPNG(
    originalPngBuffer: Buffer,
    updatedM3U8Content: string,
    originalPath: string
  ): Promise<string> {
    // Find the end of PNG data (IEND chunk)
    const iendSignature = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const iendIndex = originalPngBuffer.indexOf(iendSignature);

    if (iendIndex === -1) {
      throw new Error('Invalid PNG file: IEND chunk not found');
    }

    // Extract only the PNG part (up to and including IEND chunk)
    const pngOnlyBuffer = originalPngBuffer.slice(0, iendIndex + iendSignature.length);

    // Convert updated M3U8 content to buffer
    const updatedM3U8Buffer = Buffer.from(updatedM3U8Content, 'utf8');

    // Combine PNG + updated M3U8 content
    const updatedPngBuffer = Buffer.concat([pngOnlyBuffer, updatedM3U8Buffer]);

    // Create new file path for the updated PNG
    const updatedPath = originalPath.replace('.png', '_updated.png');

    // Write the updated PNG file
    await fs.writeFile(updatedPath, updatedPngBuffer);

    return updatedPath;
  }

  /**
   * Retries failed uploads with exponential backoff and account rotation
   * @param failedUploads - Array of failed upload results
   * @param accounts - Available TikTok accounts
   * @returns Array of retry results
   */
  private async retryFailedUploads(
    failedUploads: UploadResult[],
    accounts: TiktokAccount[]
  ): Promise<UploadResult[]> {
    logger.info(
      `🔄 Retrying ${failedUploads.length} failed uploads (max ${this.retryConfig.maxRetries} retries per file)...`
    );

    const retryResults: UploadResult[] = [];

    for (const failedUpload of failedUploads) {
      let lastError: UploadResult = failedUpload;
      let retryAttempt = 0;

      // Try to find a different account (skip rate-limited ones)
      const availableAccounts = accounts.filter(account => account.id !== failedUpload.accountId);
      const accountsToTry = availableAccounts.length > 0 ? availableAccounts : accounts;

      while (retryAttempt < this.retryConfig.maxRetries) {
        retryAttempt++;

        // Calculate delay with exponential backoff
        const delayMs = Math.min(
          this.retryConfig.initialDelayMs *
            Math.pow(this.retryConfig.backoffMultiplier, retryAttempt - 1),
          this.retryConfig.maxDelayMs
        );

        logger.info(
          `🔄 Retry attempt ${retryAttempt}/${this.retryConfig.maxRetries} for ${failedUpload.originalPath} (waiting ${delayMs}ms)...`
        );

        await this.delay(delayMs);

        // Rotate through available accounts
        const accountIndex = (retryAttempt - 1) % accountsToTry.length;
        const account = accountsToTry[accountIndex];

        try {
          const retryResult = await this.uploadSingleFile(failedUpload.filePath, account);

          if (retryResult.success) {
            logger.info(
              `✅ Retry succeeded for ${failedUpload.originalPath} on attempt ${retryAttempt} using account ${account.name}`
            );
            retryResults.push(retryResult);
            break; // Success, move to next failed upload
          } else {
            lastError = retryResult;
            logger.warn(
              `⚠️ Retry attempt ${retryAttempt} failed for ${failedUpload.originalPath}: ${retryResult.error}`
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.warn(
            `⚠️ Retry attempt ${retryAttempt} threw error for ${failedUpload.originalPath}: ${errorMessage}`
          );
          lastError = {
            ...failedUpload,
            error: errorMessage,
            accountId: account.id || 'unknown',
          };
        }

        // If this was the last retry attempt, add the failed result
        if (retryAttempt === this.retryConfig.maxRetries) {
          logger.error(
            `❌ All ${this.retryConfig.maxRetries} retry attempts failed for ${failedUpload.originalPath}`
          );
          retryResults.push(lastError);
        }
      }
    }

    const successfulRetries = retryResults.filter(r => r.success).length;
    const failedRetries = retryResults.length - successfulRetries;

    logger.info(`🔄 Retry summary: ${successfulRetries} succeeded, ${failedRetries} still failed`);

    return retryResults;
  }

  /**
   * Simple delay utility
   * @param ms - Milliseconds to delay
   * @returns Promise that resolves after the delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = globalThis.setTimeout(resolve, ms);
      return timer;
    });
  }
}
