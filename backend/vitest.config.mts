import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // argon2 hashing makes signup take a moment; keep runs deterministic
    testTimeout: 20000,
    pool: 'forks'
  }
});
