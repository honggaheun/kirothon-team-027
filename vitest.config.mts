// Root vitest config: only guard/test checks run here.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['guard/test/**/*.test.ts'],
    setupFiles: ['guard/test/setup.ts'],
  },
});
