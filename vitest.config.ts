import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'path';

export default defineConfig({
  plugins: [tsconfigPaths({ loose: true })],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['test/helpers/setup.ts'],
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'src/services/**',
        'src/utils/errorSanitizer.ts',
        'src/config/index.ts',
        'src/types/index.ts',
      ],
      exclude: [
        'src/types/database.ts',
        'src/types/common.ts',
        'src/index.ts',
        'src/config/supabase.ts',
        'src/utils/logger.ts',
        'src/scripts/**',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
