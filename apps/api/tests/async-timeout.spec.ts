import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  AsyncTimeoutError,
  runWithTimeout,
} from '../src/async-timeout.js';

describe('async timeout helper', () => {
  it('returns operation result before timeout', async () => {
    const result = await runWithTimeout(
      async () => 'ok',
      500,
    );
    expect(result).toBe('ok');
  });

  it('throws AsyncTimeoutError when operation exceeds timeout', async () => {
    vi.useFakeTimers();
    try {
      const pending = runWithTimeout(
        () => new Promise<string>(() => {}),
        25,
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(25);
      const caught = await pending;
      expect(caught).toBeInstanceOf(AsyncTimeoutError);
      expect(caught).toMatchObject({
        timeoutMs: 25,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
