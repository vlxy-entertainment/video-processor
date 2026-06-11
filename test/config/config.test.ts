import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Prevent dotenv from loading .env file so we control the full env ourselves.
vi.mock('dotenv', () => ({ config: vi.fn() }));

describe('getEnvConfig', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns a parsed config', async () => {
    const { getEnvConfig } = await import('@/config');
    expect(getEnvConfig().SUPABASE_URL).toBe(process.env.SUPABASE_URL);
  });

  it('throws a wrapped error when required env is missing', async () => {
    delete process.env.TORBOX_TOKEN;
    // The module-level `envConfig = getEnvConfig()` runs at import, so the import itself rejects.
    await expect(import('@/config')).rejects.toThrow(/Environment configuration error/);
  });
});
