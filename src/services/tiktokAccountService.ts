import { supabase } from '@/config/supabase';
import { logger } from '@/utils/logger';
import { TiktokAccount } from '@/types';

/**
 * Service for managing TikTok accounts
 */
export class TiktokAccountService {
  private readonly accountsTable = 'tiktok_accounts';

  /**
   * Fetches all active TikTok accounts
   * @returns Promise that resolves to array of active TikTok accounts
   */
  async getActiveAccounts(): Promise<TiktokAccount[]> {
    try {
      const { data, error } = await supabase
        .from(this.accountsTable)
        .select('*')
        .eq('status', 'active')
        .order('last_upload_at', { ascending: true }); // Prioritize accounts that haven't been used recently

      if (error) {
        logger.error('Failed to fetch active TikTok accounts:', error);
        throw new Error(`Failed to fetch active TikTok accounts: ${error.message}`);
      }

      if (!data || data.length === 0) {
        logger.warn('No active TikTok accounts found');
        return [];
      }

      // Map database records to TiktokAccount objects
      const accounts: TiktokAccount[] = data.map(account => ({
        id: account.id,
        name: account.name,
        aadvid: account.aadvid,
        sid_guard_ads: account.sid_guard_ads,
        csrftoken: account.csrftoken,
        status: account.status,
        upload_count: account.upload_count || 0,
        last_upload_at: account.last_upload_at,
        cooldown_until: account.cooldown_until,
        created_at: account.created_at,
        updated_at: account.updated_at,
      }));

      logger.info(`Found ${accounts.length} active TikTok accounts`);
      return accounts;
    } catch (error) {
      logger.error('Error fetching active TikTok accounts:', error);
      throw error;
    }
  }

  /**
   * Updates account upload statistics after a successful upload
   * @param accountId - The account ID to update
   * @returns Promise that resolves when update is complete
   */
  async updateUploadStats(accountId: string): Promise<void> {
    try {
      // First get the current upload count, then increment it
      const { data: currentData, error: fetchError } = await supabase
        .from(this.accountsTable)
        .select('upload_count')
        .eq('id', accountId)
        .single();

      if (fetchError) {
        logger.error(`Failed to fetch current upload count for account ${accountId}:`, fetchError);
        throw new Error(`Failed to fetch current upload count: ${fetchError.message}`);
      }

      const newUploadCount = (currentData.upload_count || 0) + 1;

      const { error } = await supabase
        .from(this.accountsTable)
        .update({
          upload_count: newUploadCount,
          last_upload_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', accountId);

      if (error) {
        logger.error(`Failed to update upload stats for account ${accountId}:`, error);
        throw new Error(`Failed to update upload stats: ${error.message}`);
      }

      logger.debug(`Updated upload stats for account ${accountId} (count: ${newUploadCount})`);
    } catch (error) {
      logger.error(`Error updating upload stats for account ${accountId}:`, error);
      throw error;
    }
  }

  /**
   * Sets account status to limited with cooldown
   * @param accountId - The account ID to update
   * @param cooldownHours - Hours to cooldown (default 24)
   * @returns Promise that resolves when update is complete
   */
  async setAccountLimited(accountId: string, cooldownHours: number = 24): Promise<void> {
    try {
      const cooldownUntil = new Date();
      cooldownUntil.setHours(cooldownUntil.getHours() + cooldownHours);

      const { error } = await supabase
        .from(this.accountsTable)
        .update({
          status: 'limited',
          cooldown_until: cooldownUntil.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', accountId);

      if (error) {
        logger.error(`Failed to set account ${accountId} as limited:`, error);
        throw new Error(`Failed to set account as limited: ${error.message}`);
      }

      logger.warn(`Set account ${accountId} as limited until ${cooldownUntil.toISOString()}`);
    } catch (error) {
      logger.error(`Error setting account ${accountId} as limited:`, error);
      throw error;
    }
  }

  /**
   * Updates the CSRF token for a specific account
   * @param accountId - The account ID to update
   * @param csrfToken - The new CSRF token
   * @returns Promise that resolves when update is complete
   */
  async updateCsrfToken(accountId: string, csrfToken: string): Promise<void> {
    try {
      const { error } = await supabase
        .from(this.accountsTable)
        .update({
          csrftoken: csrfToken,
          updated_at: new Date().toISOString(),
        })
        .eq('id', accountId);

      if (error) {
        logger.error(`Failed to update CSRF token for account ${accountId}:`, error);
        throw new Error(`Failed to update CSRF token: ${error.message}`);
      }

      logger.debug(`Updated CSRF token for account ${accountId}`);
    } catch (error) {
      logger.error(`Error updating CSRF token for account ${accountId}:`, error);
      throw error;
    }
  }
}
