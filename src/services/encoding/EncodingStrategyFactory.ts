import { logger } from '@/utils/logger';
import type { EncodingStrategy } from '@/services/encoding/EncodingStrategy';
import { NvidiaEncodingStrategy } from '@/services/encoding/NvidiaEncodingStrategy';
import { IntelQsvEncodingStrategy } from '@/services/encoding/IntelQsvEncodingStrategy';
import { CpuEncodingStrategy } from '@/services/encoding/CpuEncodingStrategy';

/**
 * Factory that selects the best available encoding strategy for the current
 * machine. Detection runs once and is cached for the process lifetime.
 */
export class EncodingStrategyFactory {
  /** Cached winner of the one-time hardware probe. */
  private static cachedStrategy: EncodingStrategy | null = null;

  /**
   * Candidate strategies in priority order. The last entry (libx264) is always
   * available, guaranteeing a working encoder on any host.
   */
  private static candidates(): EncodingStrategy[] {
    return [
      new NvidiaEncodingStrategy('p4'),
      new IntelQsvEncodingStrategy('fast'),
      new CpuEncodingStrategy('medium'),
    ];
  }

  /**
   * Returns the best available encoding strategy, detecting hardware once and
   * caching the result.
   * @returns The selected strategy.
   */
  static async createStrategy(): Promise<EncodingStrategy> {
    if (this.cachedStrategy) return this.cachedStrategy;

    for (const candidate of this.candidates()) {
      const available = await candidate.isAvailable();
      if (available) {
        logger.info(`🚀 Selected encoding strategy: ${candidate.getName()}`);
        this.cachedStrategy = candidate;
        return candidate;
      }
      logger.debug(`Encoder not available, trying next: ${candidate.getName()}`);
    }

    // Unreachable in practice: CpuEncodingStrategy.isAvailable() is the floor.
    const fallback = new CpuEncodingStrategy('medium');
    logger.warn('⚠️ No encoder probe succeeded; forcing libx264 fallback');
    this.cachedStrategy = fallback;
    return fallback;
  }

  /**
   * Returns every available strategy (probed live; not cached). For diagnostics.
   * @returns The available strategies.
   */
  static async getAvailableStrategies(): Promise<EncodingStrategy[]> {
    const available: EncodingStrategy[] = [];
    for (const candidate of this.candidates()) {
      if (await candidate.isAvailable()) available.push(candidate);
    }
    return available;
  }

  /**
   * Returns strategy info for debugging/logging.
   * @returns Available strategy names and the recommended one.
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
