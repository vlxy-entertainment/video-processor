import { logger } from '@/utils/logger';
import { EncodingStrategy } from '@/services/encoding/EncodingStrategy';
import { NvidiaEncodingStrategy } from '@/services/encoding/NvidiaEncodingStrategy';

/**
 * Factory for creating encoding strategies based on system capabilities
 */
export class EncodingStrategyFactory {
  /**
   * Create the best available encoding strategy
   * @returns Promise resolving to the best encoding strategy
   */
  static async createStrategy(): Promise<EncodingStrategy> {
    // Always use NVIDIA NVENC encoder
    logger.info('🚀 Using NVIDIA NVENC encoding strategy');
    return new NvidiaEncodingStrategy('p1');
  }

  /**
   * Get all available encoding strategies
   * @returns Promise resolving to array of available strategies
   */
  static async getAvailableStrategies(): Promise<EncodingStrategy[]> {
    // Always return NVIDIA NVENC strategy
    return [new NvidiaEncodingStrategy('p1')];
  }

  /**
   * Get strategy information for debugging
   * @returns Promise resolving to strategy information
   */
  static async getStrategyInfo(): Promise<{
    availableStrategies: string[];
    recommendedStrategy: string;
  }> {
    const availableStrategies = await this.getAvailableStrategies();
    const recommendedStrategy = await this.createStrategy();

    return {
      availableStrategies: availableStrategies.map(s => s.getName()),
      recommendedStrategy: recommendedStrategy.getName(),
    };
  }
}
