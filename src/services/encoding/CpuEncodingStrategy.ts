import ffmpeg from 'fluent-ffmpeg';
import { logger } from '@/utils/logger';
import { EncodingStrategy } from '@/services/encoding/EncodingStrategy';

/**
 * CPU encoding strategy using libx264
 */
export class CpuEncodingStrategy implements EncodingStrategy {
  private readonly preset: string;

  constructor(preset: string = 'medium') {
    this.preset = preset;
  }

  getName(): string {
    return 'CPU (libx264)';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise(resolve => {
      // Test if libx264 is available by running a simple FFmpeg command
      ffmpeg()
        .input('testsrc=duration=1:size=320x240:rate=1')
        .outputOptions(['-c:v', 'libx264', '-f', 'null'])
        .output('-')
        .on('error', () => {
          logger.debug('CPU libx264 not available');
          resolve(false);
        })
        .on('end', () => {
          logger.debug('CPU libx264 is available');
          resolve(true);
        })
        .run();
    });
  }

  getOptions(): string[] {
    return [
      '-c:v',
      'libx264',
      '-preset',
      this.preset,
      '-crf',
      '23',
      '-threads',
      '0', // Use all available CPU cores
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
    ];
  }
}
