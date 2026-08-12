import { defineProject } from 'vitest/config';

export default defineProject({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['tests/*.test.ts'],
    sequence: { shuffle: false },
  },
});
