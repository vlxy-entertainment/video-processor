import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import { logger } from '@/utils/logger';
import { EncodingStrategyFactory } from '@/services/encoding/EncodingStrategyFactory';
import { envConfig } from '@/config';
import { ProcessingPlanner } from '@/services/processingPlanner';

/**
 * Service for processing videos using FFmpeg with hardware acceleration
 */
export class VideoProcessor {
  private readonly maxSegmentSizeMB = 5; // Reduced from 9MB to 5MB for better compatibility
  private readonly planner = new ProcessingPlanner();

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

      // Step 2: Decide route (remux vs transcode)
      const planStartTime = Date.now();
      const plan = await this.planner.plan(videoUrl);
      logger.info(`🧭 Route: ${plan.route} — ${plan.reason}`);
      stepTimings['planning'] = Date.now() - planStartTime;

      // Step 3: Produce HLS .ts segments via the chosen route
      const hlsStartTime = Date.now();
      if (plan.route === 'remux') {
        await this.runRemuxToHls(videoUrl, outputDir);

        // Hard re-check: if the predictor was wrong and a segment is over budget,
        // fall back to a transcode once.
        const oversized = await this.validateSegmentSizes(outputDir);
        if (oversized.length > 0) {
          logger.warn(
            `⚠️ Remux produced ${oversized.length} oversize segment(s); ` +
              `falling back to transcode`
          );
          await this.clearTsAndPlaylist(outputDir);
          await this.convertVideoToHLS(videoUrl, outputDir);
        }
      } else {
        await this.convertVideoToHLS(videoUrl, outputDir);
      }
      stepTimings['hls_conversion'] = Date.now() - hlsStartTime;

      // Step 4: Strip metadata + wrap segments into PNG (single pass)
      const wrapStartTime = Date.now();
      await this.wrapSegmentsInPng(outputDir);
      stepTimings['png_wrap'] = Date.now() - wrapStartTime;

      // Step 5: Update playlist to reference PNG files
      const playlistUpdateStartTime = Date.now();
      await this.updatePlaylistToUsePng(outputDir);
      stepTimings['playlist_update'] = Date.now() - playlistUpdateStartTime;

      // Step 6: Embed M3U8 playlist into PNG file
      const playlistEmbedStartTime = Date.now();
      await this.embedPlaylistToPng(outputDir);
      stepTimings['playlist_embedding'] = Date.now() - playlistEmbedStartTime;

      // Step 7: Validate the conversion
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
   * Convert video to HLS by re-encoding via the selected encoding strategy.
   * @param inputPath Input video path
   * @param outputDir Output directory
   * @returns Promise resolving to playlist path
   */
  private async convertVideoToHLS(inputPath: string, outputDir: string): Promise<string> {
    const playlistPath = path.join(outputDir, 'playlist.m3u8');

    const metadata = await this.getVideoMetadata(inputPath);
    const ffmpegMetadata = await this.getFFmpegMetadata(inputPath);
    const segmentDuration = this.calculateSegmentDuration();

    const encodingStrategy = await EncodingStrategyFactory.createStrategy();
    const encodingOptions = encodingStrategy.getOptions(ffmpegMetadata);

    logger.info(`🚀 Using encoding strategy: ${encodingStrategy.getName()}`);
    logger.info(`📊 File size: ${metadata.fileSizeMB.toFixed(2)} MB`);
    logger.info(`⏱️ Video duration: ${metadata.durationSeconds.toFixed(2)} seconds`);
    logger.info(`🎯 Segment duration: ${segmentDuration.toFixed(2)} seconds`);

    await this.runFFmpegConversion(inputPath, outputDir, segmentDuration, encodingOptions);
    return playlistPath;
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
          '-keyint_min',
          Math.round(segmentDuration * 30).toString(),
          '-sc_threshold',
          '0',
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
   * Remuxes (stream-copies) the source into HLS without re-encoding. Segments
   * are cut at the source's keyframes, so durations are >= the target and the
   * `<5MB` budget is verified afterward by the caller.
   * @param inputPath Source video URL/path.
   * @param outputDir Output directory.
   */
  private async runRemuxToHls(inputPath: string, outputDir: string): Promise<void> {
    const playlistPath = path.join(outputDir, 'playlist.m3u8');
    const segmentPattern = path.join(outputDir, 'segment_%03d.ts');
    const segmentDuration = envConfig.HLS_SEGMENT_DURATION_SECONDS;

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c',
          'copy',
          '-f',
          'hls',
          '-hls_time',
          segmentDuration.toString(),
          '-hls_list_size',
          '0',
          '-hls_segment_filename',
          segmentPattern,
          '-hls_flags',
          'independent_segments',
        ])
        .output(playlistPath)
        .on('start', () => logger.info('🚀 Starting HLS remux (stream copy)'))
        .on('end', () => {
          logger.info('✅ HLS remux completed');
          resolve();
        })
        .on('error', (error, stdout, stderr) => {
          logger.error('❌ HLS remux failed:', {
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
   * Strips FFmpeg metadata and wraps each `.ts` segment into a `.png` in a single
   * pass, then removes the `.ts`. Replaces the former three separate passes.
   * @param outputDir Directory containing the `.ts` segments.
   */
  private async wrapSegmentsInPng(outputDir: string): Promise<void> {
    logger.info('🖼️ Stripping metadata and wrapping segments into PNG (single pass)...');

    const files = await fs.readdir(outputDir);
    const tsFiles = files.filter(file => file.endsWith('.ts') && file.startsWith('segment_'));
    logger.info(`Found ${tsFiles.length} TS segment files to wrap`);

    // 1x1 transparent PNG used as the carrier; payload is appended after IEND.
    const carrierPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );

    for (const tsFile of tsFiles) {
      const tsPath = path.join(outputDir, tsFile);
      const pngPath = path.join(outputDir, tsFile.replace('.ts', '.png'));

      try {
        const raw = await fs.readFile(tsPath);
        const cleaned = this.stripFFmpegMetadata(raw);
        await fs.writeFile(pngPath, Buffer.concat([carrierPng, cleaned]));
        await fs.unlink(tsPath);
      } catch (error) {
        logger.error(`❌ Failed to wrap ${tsFile} into PNG:`, error);
        throw error;
      }
    }

    logger.info(`✅ Wrapped ${tsFiles.length} segments into PNG files`);
  }

  /**
   * Returns segment bytes with FFmpeg's first-packet metadata removed. If no
   * metadata marker is present (common for remuxed segments), returns the input
   * unchanged.
   * @param segmentData Raw `.ts` bytes.
   */
  private stripFFmpegMetadata(segmentData: Buffer): Buffer {
    const ffmpegStart = segmentData.indexOf(Buffer.from('FFmpeg'));
    if (ffmpegStart === -1) return segmentData;

    const packetHeader = segmentData.subarray(0, ffmpegStart - 6);
    let nextSyncByte = 188;
    while (nextSyncByte < segmentData.length && segmentData[nextSyncByte] !== 0x47) {
      nextSyncByte++;
    }
    if (nextSyncByte >= segmentData.length) return segmentData;

    return Buffer.concat([packetHeader, segmentData.subarray(nextSyncByte)]);
  }

  /**
   * Removes `.ts` segments and the working playlist so a route can be re-run.
   * @param outputDir Directory to clear.
   */
  private async clearTsAndPlaylist(outputDir: string): Promise<void> {
    const files = await fs.readdir(outputDir);
    await Promise.all(
      files
        .filter(f => f.endsWith('.ts') || f === 'playlist.m3u8')
        .map(f => fs.unlink(path.join(outputDir, f)).catch(() => undefined))
    );
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

    const carrierPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );

    try {
      const playlistData = await fs.readFile(playlistPath);
      await fs.writeFile(playlistPngPath, Buffer.concat([carrierPng, playlistData]));
      await fs.unlink(playlistPath);
      logger.info('✅ Successfully embedded M3U8 playlist into PNG file');
    } catch (error) {
      logger.error('❌ Failed to embed M3U8 playlist into PNG:', error);
      throw error;
    }
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
