import { createClient } from '@supabase/supabase-js';
import { envConfig } from '@/config';
import { logger } from '@/utils/logger';

/**
 * Supabase client instance using service role key for server-side operations
 * This bypasses RLS policies and allows full database access
 */
export const supabase = createClient(envConfig.SUPABASE_URL, envConfig.SUPABASE_SECRET_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Tests the Supabase connection
 * @returns Promise that resolves to true if connection is successful
 */
export async function testSupabaseConnection(): Promise<boolean> {
  try {
    const { error } = await supabase.from('video_processing_queue').select('count').limit(1);

    if (error) {
      logger.error('Supabase connection test failed:', error);
      return false;
    }

    logger.info('Supabase connection test successful');
    return true;
  } catch (error) {
    logger.error('Supabase connection test failed with exception:', error);
    return false;
  }
}
