import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/tripwire/**/*.prop.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // 속성 하나당 Python 프로세스를 100번 새로 띄운다.
    testTimeout: 180000,
  },
});
