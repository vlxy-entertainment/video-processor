import { config } from 'dotenv';
import { EnvConfigSchema, type EnvConfig } from '@/types';

// Load environment variables
config();

/**
 * Validates and returns the environment configuration
 * @returns The validated environment configuration
 * @throws Error if validation fails
 */
export function getEnvConfig(): EnvConfig {
  try {
    return EnvConfigSchema.parse(process.env);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Environment configuration error: ${error.message}`);
    }
    throw new Error('Unknown environment configuration error');
  }
}

/**
 * Global environment configuration instance
 */
export const envConfig = getEnvConfig();
