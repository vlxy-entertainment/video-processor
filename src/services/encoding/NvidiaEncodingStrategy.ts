import ffmpeg from 'fluent-ffmpeg';
import { logger } from '@/utils/logger';
import { EncodingStrategy } from '@/services/encoding/EncodingStrategy';

/**
 * NVIDIA NVENC encoding strategy
 */
export class NvidiaEncodingStrategy implements EncodingStrategy {
  private readonly preset: string;

  constructor(preset: string = 'p1') {
    this.preset = preset;
  }

  getName(): string {
    return 'NVIDIA NVENC';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise(resolve => {
      // Test if NVENC is available by running a simple FFmpeg command
      ffmpeg()
        .input('testsrc=duration=1:size=320x240:rate=1')
        .outputOptions(['-c:v', 'h264_nvenc', '-f', 'null'])
        .output('-')
        .on('error', () => {
          logger.debug('NVIDIA NVENC not available');
          resolve(false);
        })
        .on('end', () => {
          logger.debug('NVIDIA NVENC is available');
          resolve(true);
        })
        .run();
    });
  }

  getOptions(metadata: ffmpeg.FfprobeData): string[] {
    const targetBitrateKbps = 10000000 / 1000;

    // Get video dimensions
    const width = metadata.streams?.[0]?.width || 1920;
    const height = metadata.streams?.[0]?.height || 1080;

    // Scale down to 1080p if video is higher resolution
    let scaleFilter = '';
    if (width > 1920 || height > 1080) {
      scaleFilter = `scale=1920:1080:force_original_aspect_ratio=decrease`;
      logger.info(`📐 Scaling video from ${width}x${height} to 1080p`);
    }

    const options = [
      '-c:v',
      'h264_nvenc',
      '-preset',
      this.preset,
      '-rc',
      'cbr',
      '-b:v',
      `${targetBitrateKbps}k`,
      '-maxrate',
      `${targetBitrateKbps}k`,
      '-bufsize',
      `${targetBitrateKbps}k`,
      '-g',
      '30',
      '-keyint_min',
      '30',
      '-sc_threshold',
      '0',
      '-force_key_frames',
      'expr:gte(t,n_forced*1)',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-ac',
      '2',
    ];

    // Add scale filter if needed
    if (scaleFilter) {
      options.push('-vf', scaleFilter);
    }

    return options;
  }
}
