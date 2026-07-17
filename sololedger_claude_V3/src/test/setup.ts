import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount React trees after each test to avoid cross-test DOM leakage.
afterEach(() => {
  cleanup();
});
