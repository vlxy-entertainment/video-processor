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
    // Ceiling so a high-bitrate source cannot blow the per-segment budget;
    // capped VBR keeps modest sources small while staying visually identical.
    const maxBitrateKbps = 10_000;

    const width = metadata.streams?.[0]?.width || 1920;
    const height = metadata.streams?.[0]?.height || 1080;

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
      'vbr',
      '-cq',
      '23',
      '-maxrate',
      `${maxBitrateKbps}k`,
      '-bufsize',
      `${maxBitrateKbps * 2}k`,
      // NOTE: keyframe placement (-g / -force_key_frames) is owned by
      // VideoProcessor.runFFmpegConversion so segments align to segment
      // boundaries. Do not set it here.
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-ac',
      '2',
    ];

    if (scaleFilter) {
      options.push('-vf', scaleFilter);
    }

    return options;
  }
}
