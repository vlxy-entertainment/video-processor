import ffmpeg from 'fluent-ffmpeg';

/**
 * Base interface for video encoding strategies
 */
export interface EncodingStrategy {
  /**
   * Get the name of this encoding strategy
   * @returns Strategy name
   */
  getName(): string;

  /**
   * Check if this encoding strategy is available on the current system
   * @returns Promise resolving to true if available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get FFmpeg encoding options for this strategy
   * @param metadata Video metadata
   * @returns Array of FFmpeg output options
   */
  getOptions(metadata: ffmpeg.FfprobeData): string[];
}
