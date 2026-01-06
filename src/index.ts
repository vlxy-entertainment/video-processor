import { logger } from '@/utils/logger';
import { testSupabaseConnection } from '@/config/supabase';
import { Scheduler } from '@/services/scheduler';
import { envConfig } from '@/config';

/**
 * Main application class
 */
class App {
  private scheduler: Scheduler;

  constructor() {
    this.scheduler = new Scheduler(1); // Run every 1 minute
  }

  /**
   * Initializes the application
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing TikTok Video Uploader...');

      // Test Supabase connection
      const isConnected = await testSupabaseConnection();
      if (!isConnected) {
        throw new Error('Failed to connect to Supabase');
      }

      logger.info('Application initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize application:', error);
      throw error;
    }
  }

  /**
   * Starts the application
   */
  async start(): Promise<void> {
    try {
      await this.initialize();

      logger.info('Starting TikTok Video Uploader...');
      logger.info(`Log level: ${envConfig.LOG_LEVEL}`);
      logger.info(`Log file: ${envConfig.LOG_FILE_PATH}`);

      // Start the scheduler to poll the video processing queue
      this.scheduler.start();

      logger.info('TikTok Video Uploader started successfully');
    } catch (error) {
      logger.error('Failed to start application:', error);
      process.exit(1);
    }
  }

  /**
   * Stops the application
   */
  async stop(): Promise<void> {
    try {
      logger.info('Stopping TikTok Video Uploader...');

      // Stop the scheduler
      this.scheduler.stop();

      logger.info('TikTok Video Uploader stopped successfully');
    } catch (error) {
      logger.error('Error stopping application:', error);
    }
  }
}

/**
 * Main application instance
 */
const app = new App();

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    await app.stop();
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

// Handle process signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the application
app.start().catch(error => {
  logger.error('Failed to start application:', error);
  process.exit(1);
});
