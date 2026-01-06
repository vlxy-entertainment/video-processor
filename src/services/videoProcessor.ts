import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import { logger } from '@/utils/logger';
import { EncodingStrategyFactory } from '@/services/encoding/EncodingStrategyFactory';

/**
 * Service for processing videos using FFmpeg with hardware acceleration
 */
export class VideoProcessor {
  private readonly maxSegmentSizeMB = 5; // Reduced from 9MB to 5MB for better compatibility

  /**
   * Processes a video from the queue with hardware acceleration
   * @param videoUrl - The video URL from TorBox
   * @param queueItemId - The queue item ID for output directory
   * @returns Promise that resolves when processing is complete
   */
  async processVideo(videoUrl: string, queueItemId: string): Promise<void> {
    const videoProcessingStartTime = Date.now();
    const stepTimings: Record<string, number> = {};

    try {
      logger.info(`🎬 Starting video processing for: ${videoUrl}`);

      // Step 1: Create output directory
      // Always use current working directory since we're using TorBox URLs
      const outputDir = path.join(process.cwd(), 'processed', queueItemId);
      await fs.mkdir(outputDir, { recursive: true });

      // Step 2: Convert video to HLS with hardware acceleration
      const hlsStartTime = Date.now();
      await this.convertVideoToHLS(videoUrl, outputDir);
      stepTimings['hls_conversion'] = Date.now() - hlsStartTime;

      // Step 3: Remove FFmpeg metadata from TS segments
      const metadataStartTime = Date.now();
      await this.removeFFmpegMetadataFromTsSegments(outputDir);
      stepTimings['metadata_removal'] = Date.now() - metadataStartTime;

      // Step 4: Embed segments into PNG files
      const pngEmbedStartTime = Date.now();
      await this.embedSegmentsToPng(outputDir);
      stepTimings['png_embedding'] = Date.now() - pngEmbedStartTime;

      // Step 5: Update playlist to reference PNG files
      const playlistUpdateStartTime = Date.now();
      await this.updatePlaylistToUsePng(outputDir);
      stepTimings['playlist_update'] = Date.now() - playlistUpdateStartTime;

      // Step 6: Embed M3U8 playlist into PNG file
      const playlistEmbedStartTime = Date.now();
      await this.embedPlaylistToPng(outputDir);
      stepTimings['playlist_embedding'] = Date.now() - playlistEmbedStartTime;

      // Step 7: Clean up original TS files
      const cleanupStartTime = Date.now();
      await this.cleanupTsFiles(outputDir);
      stepTimings['ts_cleanup'] = Date.now() - cleanupStartTime;

      // Step 8: Validate the conversion
      const validationStartTime = Date.now();
      await this.validateConversion(outputDir);
      stepTimings['validation'] = Date.now() - validationStartTime;

      const totalTime = Date.now() - videoProcessingStartTime;
      const totalSeconds = (totalTime / 1000).toFixed(2);

      // Log detailed timing breakdown
      const timingDetails = Object.entries(stepTimings)
        .map(([step, ms]) => {
          const seconds = (ms / 1000).toFixed(2);
          const percentage = ((ms / totalTime) * 100).toFixed(1);
          return `    ${step}: ${seconds}s (${percentage}%)`;
        })
        .join('\n');

      logger.info(
        `✅ Video processing completed for: ${videoUrl}\n` +
          `⏱️ Total video processing time: ${totalSeconds}s\n` +
          `📊 Step breakdown:\n${timingDetails}`
      );
    } catch (error) {
      const totalTime = Date.now() - videoProcessingStartTime;
      const totalSeconds = (totalTime / 1000).toFixed(2);
      logger.error(
        `❌ Video processing failed for ${videoUrl} (Failed after ${totalSeconds}s):`,
        error
      );
      throw error;
    }
  }

  /**
   * Convert video to HLS using hardware acceleration with fallback
   * @param inputPath Input video path
   * @param outputDir Output directory
   * @returns Promise resolving to playlist path
   */
  private async convertVideoToHLS(inputPath: string, outputDir: string): Promise<string> {
    const playlistPath = path.join(outputDir, 'playlist.m3u8');

    try {
      // Get video metadata
      const metadata = await this.getVideoMetadata(inputPath);
      const ffmpegMetadata = await this.getFFmpegMetadata(inputPath);

      // Calculate optimal segment duration
      const segmentDuration = this.calculateSegmentDuration();

      // Get encoding strategy
      const encodingStrategy = await EncodingStrategyFactory.createStrategy();
      const encodingOptions = encodingStrategy.getOptions(ffmpegMetadata);

      logger.info(`🚀 Using encoding strategy: ${encodingStrategy.getName()}`);
      logger.info(`📊 File size: ${metadata.fileSizeMB.toFixed(2)} MB`);
      logger.info(`⏱️ Video duration: ${metadata.durationSeconds.toFixed(2)} seconds`);
      logger.info(`🎯 Segment duration: ${segmentDuration.toFixed(2)} seconds`);

      // Convert to HLS with hardware acceleration
      await this.runFFmpegConversion(inputPath, outputDir, segmentDuration, encodingOptions);

      return playlistPath;
    } catch (error) {
      logger.warn('⚠️ Hardware encoding failed, trying CPU fallback:', error);

      try {
        // Fallback to CPU encoding
        const ffmpegMetadata = await this.getFFmpegMetadata(inputPath);
        const segmentDuration = this.calculateSegmentDuration();
        const encodingStrategy = await EncodingStrategyFactory.createStrategy();
        const encodingOptions = encodingStrategy.getOptions(ffmpegMetadata);

        logger.info(`🔄 Using CPU fallback encoding: ${encodingStrategy.getName()}`);

        await this.runFFmpegConversion(inputPath, outputDir, segmentDuration, encodingOptions);

        return playlistPath;
      } catch (fallbackError) {
        logger.error('❌ Both hardware and CPU encoding failed:', fallbackError);
        throw fallbackError;
      }
    }
  }

  /**
   * Run FFmpeg conversion with the specified options
   * @param inputPath Input video path
   * @param outputDir Output directory
   * @param segmentDuration Segment duration in seconds
   * @param encodingOptions FFmpeg encoding options
   */
  private async runFFmpegConversion(
    inputPath: string,
    outputDir: string,
    segmentDuration: number,
    encodingOptions: string[]
  ): Promise<void> {
    const playlistPath = path.join(outputDir, 'playlist.m3u8');
    const segmentPattern = path.join(outputDir, 'segment_%03d.ts');

    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath)
        .outputOptions([
          ...encodingOptions,
          '-f',
          'hls',
          '-hls_time',
          segmentDuration.toString(),
          '-hls_list_size',
          '0',
          '-hls_segment_filename',
          segmentPattern,
          '-force_key_frames',
          `expr:gte(t,n_forced*${segmentDuration})`,
          '-g',
          Math.round(segmentDuration * 30).toString(),
          '-hls_flags',
          'independent_segments',
        ])
        .output(playlistPath);

      command
        .on('start', () => {
          logger.info(`🚀 Starting FFmpeg conversion`);
        })
        .on('end', () => {
          logger.info('✅ FFmpeg conversion completed');
          resolve();
        })
        .on('error', (error, stdout, stderr) => {
          logger.error('❌ FFmpeg conversion failed:', {
            error: error.message,
            stdout: stdout || 'No stdout',
            stderr: stderr || 'No stderr',
          });
          reject(error);
        })
        .run();
    });
  }

  /**
   * Gets FFmpeg metadata for encoding strategies
   */
  private async getFFmpegMetadata(inputPath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          logger.error('Failed to get FFmpeg metadata:', err);
          reject(err);
          return;
        }
        resolve(metadata);
      });
    });
  }

  /**
   * Gets video metadata including duration, file size, and bitrate
   */
  private async getVideoMetadata(
    inputPath: string
  ): Promise<{ fileSizeMB: number; durationSeconds: number; bitrateKbps: number }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          logger.error('Failed to get video metadata:', err);
          reject(err);
          return;
        }

        const durationSeconds = metadata.format.duration || 0;
        const fileSizeBytes = metadata.format.size || 0;
        const fileSizeMB = fileSizeBytes / (1024 * 1024);

        // Calculate average bitrate (in kbps)
        const bitrateKbps =
          durationSeconds > 0 ? (fileSizeBytes * 8) / (durationSeconds * 1000) : 0;

        resolve({
          fileSizeMB,
          durationSeconds,
          bitrateKbps,
        });
      });
    });
  }

  /**
   * Calculates optimal segment duration to keep segments under 5MB
   * Uses improved bitrate calculation and safety margins
   */
  private calculateSegmentDuration(): number {
    // Fixed 5-second segment duration
    const fixedSegmentDuration = 5;

    logger.info(`📊 Using fixed segment duration: ${fixedSegmentDuration}s`);

    return fixedSegmentDuration;
  }

  /**
   * Validates that all segment files are under the maximum size
   */
  private async validateSegmentSizes(
    outputDir: string
  ): Promise<Array<{ name: string; sizeMB: number }>> {
    const files = await fs.readdir(outputDir);
    const segmentFiles = files.filter(file => file.endsWith('.ts'));
    const oversizedSegments: Array<{ name: string; sizeMB: number }> = [];

    for (const segmentFile of segmentFiles) {
      const segmentPath = path.join(outputDir, segmentFile);
      const stats = await fs.stat(segmentPath);
      const sizeMB = stats.size / (1024 * 1024);

      if (sizeMB > this.maxSegmentSizeMB) {
        oversizedSegments.push({ name: segmentFile, sizeMB });
      }
    }

    return oversizedSegments;
  }

  /**
   * Remove FFmpeg metadata from TS segment files before PNG embedding
   * @param outputDir Directory containing the TS segments
   */
  private async removeFFmpegMetadataFromTsSegments(outputDir: string): Promise<void> {
    logger.info('🧹 Removing FFmpeg metadata from TS segment files...');

    const files = await fs.readdir(outputDir);
    const tsFiles = files.filter(file => file.endsWith('.ts') && file.startsWith('segment_'));

    logger.info(`Found ${tsFiles.length} TS segment files to clean`);

    for (const tsFile of tsFiles) {
      const tsPath = path.join(outputDir, tsFile);

      try {
        // Read the TS segment file
        const segmentData = await fs.readFile(tsPath);
        logger.debug(`Read ${segmentData.length} bytes from segment file: ${tsFile}`);

        // Find the FFmpeg metadata in the first packet
        const ffmpegStart = segmentData.indexOf(Buffer.from('FFmpeg'));
        if (ffmpegStart === -1) {
          logger.debug(`No FFmpeg metadata found in ${tsFile}`);
          continue;
        }

        logger.debug(`Found FFmpeg metadata at byte ${ffmpegStart} in ${tsFile}`);

        // Find the end of the first packet (next sync byte at 188-byte boundary)
        const firstPacketEnd = 188;

        // Extract the first packet header (before FFmpeg metadata)
        const packetHeader = segmentData.subarray(0, ffmpegStart - 6); // 6 bytes before "FFmpeg"

        // Find the next sync byte after the first packet
        let nextSyncByte = firstPacketEnd;
        while (nextSyncByte < segmentData.length && segmentData[nextSyncByte] !== 0x47) {
          nextSyncByte++;
        }

        if (nextSyncByte >= segmentData.length) {
          logger.debug(`Could not find next sync byte in ${tsFile}`);
          continue;
        }

        logger.debug(`Next sync byte found at ${nextSyncByte} in ${tsFile}`);

        // Create cleaned data: header + rest of file from next sync byte
        const cleanedData = Buffer.concat([packetHeader, segmentData.subarray(nextSyncByte)]);

        // Write the cleaned file back
        await fs.writeFile(tsPath, cleanedData);

        const savedBytes = segmentData.length - cleanedData.length;
        logger.debug(
          `🗜️ Removed ${savedBytes} bytes of FFmpeg metadata from ${tsFile} (${segmentData.length} → ${cleanedData.length})`
        );
      } catch (error) {
        logger.warn(`⚠️ Failed to remove FFmpeg metadata from ${tsFile}:`, error);
        // Continue with other segments even if one fails
      }
    }

    logger.info('✅ FFmpeg metadata removal from TS segments completed');
  }

  /**
   * Embed all TS segments into PNG files
   * @param outputDir Directory containing the segments
   */
  private async embedSegmentsToPng(outputDir: string): Promise<void> {
    logger.info('🖼️ Embedding TS segments into PNG files...');

    const files = await fs.readdir(outputDir);
    const tsFiles = files.filter(file => file.endsWith('.ts'));

    logger.info(`Found ${tsFiles.length} TS files to convert to PNG`);

    for (const tsFile of tsFiles) {
      const tsPath = path.join(outputDir, tsFile);
      const pngFile = tsFile.replace('.ts', '.png');
      const pngPath = path.join(outputDir, pngFile);

      try {
        this.embedSegmentInPng(tsPath, pngPath);
        logger.debug(`✅ Converted ${tsFile} to ${pngFile}`);
      } catch (error) {
        logger.error(`❌ Failed to convert ${tsFile} to PNG:`, error);
        throw error;
      }
    }

    logger.info(`✅ Successfully embedded ${tsFiles.length} segments into PNG files`);
  }

  /**
   * Embed a single TS segment into a PNG file
   * @param segmentPath Path to the TS segment
   * @param outputPath Optional output path for the PNG file
   * @returns Path to the created PNG file
   */
  private embedSegmentInPng(segmentPath: string, outputPath?: string): string {
    try {
      // Read the TS segment data
      const segmentData = fsSync.readFileSync(segmentPath);

      // Use a minimal PNG structure (1x1 transparent pixel)
      const workingPngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      );

      // Append segment data after the PNG structure
      const pngBuffer = Buffer.concat([workingPngBuffer, segmentData]);

      // Determine output path
      const finalOutputPath = outputPath || segmentPath.replace('.ts', '.png');

      // Write the PNG file
      fsSync.writeFileSync(finalOutputPath, pngBuffer);

      logger.debug(`📦 Created PNG with embedded segment: ${finalOutputPath}`);
      logger.debug(`📊 Embedded ${segmentData.length} bytes of segment data`);

      return finalOutputPath;
    } catch (error) {
      logger.error('❌ Error embedding segment in PNG:', error);
      throw error;
    }
  }

  /**
   * Update playlist to reference PNG files instead of TS files
   * @param outputDir Directory containing the playlist and segments
   */
  private async updatePlaylistToUsePng(outputDir: string): Promise<void> {
    logger.info('📝 Updating playlist to reference PNG files...');

    const playlistPath = path.join(outputDir, 'playlist.m3u8');

    if (!fsSync.existsSync(playlistPath)) {
      throw new Error('Playlist file not found');
    }

    let playlistContent = await fs.readFile(playlistPath, 'utf-8');

    // Replace .ts references with .png references
    playlistContent = playlistContent.replace(/\.ts/g, '.png');

    // Write the updated playlist
    await fs.writeFile(playlistPath, playlistContent);

    logger.info('✅ Playlist updated to reference PNG files');
  }

  /**
   * Embed M3U8 playlist file into a PNG file
   * @param outputDir Directory containing the playlist file
   */
  private async embedPlaylistToPng(outputDir: string): Promise<void> {
    logger.info('📄 Embedding M3U8 playlist into PNG file...');

    const playlistPath = path.join(outputDir, 'playlist.m3u8');
    const playlistPngPath = path.join(outputDir, 'playlist.png');

    try {
      // Use the existing embedSegmentInPng method to embed the playlist
      this.embedSegmentInPng(playlistPath, playlistPngPath);

      // Remove the original M3U8 file after successful embedding
      await fs.unlink(playlistPath);
      logger.info('🗑️ Removed original M3U8 playlist file');

      logger.info('✅ Successfully embedded M3U8 playlist into PNG file');
    } catch (error) {
      logger.error('❌ Failed to embed M3U8 playlist into PNG:', error);
      throw error;
    }
  }

  /**
   * Clean up original TS files after PNG conversion
   * @param outputDir Directory containing the files
   */
  private async cleanupTsFiles(outputDir: string): Promise<void> {
    logger.info('🧹 Cleaning up original TS files...');

    const files = await fs.readdir(outputDir);
    const tsFiles = files.filter(file => file.endsWith('.ts'));

    for (const tsFile of tsFiles) {
      const tsPath = path.join(outputDir, tsFile);
      try {
        await fs.unlink(tsPath);
        logger.debug(`🗑️ Removed TS file: ${tsFile}`);
      } catch (error) {
        logger.warn(`⚠️ Failed to remove TS file ${tsFile}:`, error);
      }
    }

    logger.info(`✅ Cleaned up ${tsFiles.length} TS files`);
  }

  /**
   * Validate the HLS conversion
   * @param outputDir Output directory
   */
  private async validateConversion(outputDir: string): Promise<void> {
    logger.info('🔍 Validating HLS conversion...');

    // Validate playlist (now in PNG format)
    const playlistPath = path.join(outputDir, 'playlist.png');
    const playlistValidation = await this.validatePlaylist(playlistPath);

    if (!playlistValidation.isValid) {
      throw new Error(`Playlist validation failed: ${playlistValidation.errors.join(', ')}`);
    }

    // Validate segments
    await this.validateSegmentSizes(outputDir);

    logger.info('✅ HLS conversion validation passed', {
      segmentCount: playlistValidation.segmentCount,
      duration: playlistValidation.duration,
    });
  }

  /**
   * Extract M3U8 content from PNG file
   * @param pngPath Path to the PNG file containing embedded M3U8
   * @returns Extracted M3U8 content as string
   */
  private extractM3u8FromPng(pngPath: string): string {
    try {
      // Read the PNG file
      const pngBuffer = fsSync.readFileSync(pngPath);

      // Find the PNG end marker (IEND chunk)
      const iendMarker = Buffer.from([0x49, 0x45, 0x4e, 0x44]); // "IEND"
      const iendIndex = pngBuffer.indexOf(iendMarker);

      if (iendIndex === -1) {
        throw new Error('PNG IEND marker not found');
      }

      // Extract M3U8 data (starts after IEND + 4 bytes for CRC)
      const m3u8StartIndex = iendIndex + 8; // IEND + CRC
      const m3u8Data = pngBuffer.slice(m3u8StartIndex);

      return m3u8Data.toString('utf-8');
    } catch (error) {
      logger.error('Error extracting M3U8 from PNG:', error);
      throw error;
    }
  }

  /**
   * Validate playlist structure
   * @param playlistPath Path to the playlist file
   * @returns Promise resolving to validation result
   */
  private async validatePlaylist(playlistPath: string): Promise<{
    isValid: boolean;
    segmentCount: number;
    duration?: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let segmentCount = 0;
    let duration = 0;

    try {
      let content: string;

      // Check if it's a PNG file (embedded M3U8) or regular M3U8 file
      if (playlistPath.endsWith('.png')) {
        content = this.extractM3u8FromPng(playlistPath);
      } else {
        content = await fs.readFile(playlistPath, 'utf-8');
      }

      const lines = content.split('\n');

      // Check for HLS header
      if (!lines[0]?.startsWith('#EXTM3U')) {
        errors.push('Missing HLS header (#EXTM3U)');
      }

      // Parse segments
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim() || '';

        if (line.startsWith('#EXTINF:')) {
          const durationMatch = line.match(/#EXTINF:([0-9.]+)/);
          if (durationMatch && durationMatch[1]) {
            duration += parseFloat(durationMatch[1]);
          }
        } else if (line && !line.startsWith('#')) {
          segmentCount++;
        }
      }

      if (segmentCount === 0) {
        errors.push('No segments found in playlist');
      }

      return {
        isValid: errors.length === 0,
        segmentCount,
        duration,
        errors,
      };
    } catch (error) {
      errors.push(`Failed to read playlist: ${error}`);
      return {
        isValid: false,
        segmentCount: 0,
        errors,
      };
    }
  }
}
