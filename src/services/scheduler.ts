import { logger } from '@/utils/logger';
import { ProcessingService } from '@/services/processingService';

/**
 * Service for scheduling periodic tasks to read video processing queue
 */
export class Scheduler {
  private readonly processingService: ProcessingService;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private isProcessing: boolean = false;

  constructor(intervalMinutes: number = 1) {
    this.processingService = new ProcessingService();
    this.intervalMs = intervalMinutes * 60 * 1000; // Convert minutes to milliseconds
  }

  /**
   * Starts the scheduler
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Scheduler is already running');
      return;
    }

    logger.info(`Starting scheduler with ${this.intervalMs / 1000 / 60} minute intervals`);

    // Run immediately on start
    this.runTask();

    // Schedule periodic runs
    this.intervalId = setInterval(() => {
      this.runTask();
    }, this.intervalMs);
  }

  /**
   * Stops the scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Scheduler stopped');
    } else {
      logger.warn('Scheduler is not running');
    }
  }

  /**
   * Runs the scheduled task to process videos from the queue
   */
  private async runTask(): Promise<void> {
    // Prevent overlapping executions
    if (this.isProcessing) {
      logger.info('Scheduled task already running, skipping this execution');
      return;
    }

    this.isProcessing = true;

    try {
      logger.info('Running scheduled task to check video processing queue...');
      await this.processingService.processNextVideo();
      logger.info('Scheduled task completed successfully');
    } catch (error) {
      logger.error('Scheduled task failed:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Checks if the scheduler is running
   * @returns True if the scheduler is running
   */
  isRunning(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Gets the current interval in minutes
   * @returns The interval in minutes
   */
  getIntervalMinutes(): number {
    return this.intervalMs / 1000 / 60;
  }
}
