import { vi } from 'vitest';

// Required env vars — set before any production module is imported so that
// envConfig (parsed eagerly in src/config/index.ts) does not throw. The numeric
// vars fall through to their schema defaults.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.TIKTOK_API_ENDPOINT = 'https://www.tiktok.com';
process.env.TORBOX_TOKEN = 'test-torbox-token';

// Silence the logger everywhere; no winston, no file writes.
vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
