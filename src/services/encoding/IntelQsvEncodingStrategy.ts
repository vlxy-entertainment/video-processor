import ffmpeg from 'fluent-ffmpeg';
import { logger } from '@/utils/logger';
import { EncodingStrategy } from '@/services/encoding/EncodingStrategy';

/**
 * Intel Quick Sync Video encoding strategy
 */
export class IntelQsvEncodingStrategy implements EncodingStrategy {
  private readonly preset: string;

  constructor(preset: string = 'fast') {
    this.preset = preset;
  }

  getName(): string {
    return 'Intel Quick Sync Video';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise(resolve => {
      // Test if QSV is available by running a simple FFmpeg command
      ffmpeg()
        .input('testsrc=duration=1:size=320x240:rate=1')
        .inputOptions(['-f', 'lavfi'])
        .outputOptions(['-c:v', 'h264_qsv', '-f', 'null'])
        .output('-')
        .on('error', () => {
          logger.debug('Intel Quick Sync Video not available');
          resolve(false);
        })
        .on('end', () => {
          logger.debug('Intel Quick Sync Video is available');
          resolve(true);
        })
        .run();
    });
  }

  getOptions(metadata: ffmpeg.FfprobeData): string[] {
    const videoBitrate = this.getVideoBitrate(metadata);
    const targetBitrateKbps = Math.round(videoBitrate / 1000);

    return [
      '-c:v',
      'h264_qsv',
      '-preset',
      this.preset,
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
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
    ];
  }

  private getVideoBitrate(metadata: ffmpeg.FfprobeData): number {
    let videoBitrate = 0;

    if (metadata.streams) {
      for (const stream of metadata.streams) {
        if (stream.codec_type === 'video' && stream.bit_rate) {
          videoBitrate = parseInt(stream.bit_rate);
          break;
        }
      }
    }

    // Estimate based on resolution if not available
    if (videoBitrate === 0) {
      const width = metadata.streams?.[0]?.width || 1920;
      const height = metadata.streams?.[0]?.height || 1080;

      if (width >= 3840)
        videoBitrate = 120000000; // 4K: 120 Mbps
      else if (width >= 1920)
        videoBitrate = 40000000; // 1080p: 40 Mbps
      else if (width >= 1280)
        videoBitrate = 20000000; // 720p: 20 Mbps
      else videoBitrate = 8000000; // 480p and below: 8 Mbps

      logger.info(
        `📊 Estimated bitrate for ${width}x${height}: ${videoBitrate} bps (${(videoBitrate / 1000000).toFixed(1)} Mbps)`
      );
    } else {
      logger.info(
        `📊 Detected bitrate from metadata: ${videoBitrate} bps (${(videoBitrate / 1000000).toFixed(1)} Mbps)`
      );
    }

    return videoBitrate;
  }
}
