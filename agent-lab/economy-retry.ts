export async function runWithRetry(fn: () => Promise<void>, opts: { maxAttempts?: number; baseDelayMs?: number } = {}): Promise<void> {
  const max = opts.maxAttempts ?? 5;
  const base = opts.baseDelayMs ?? 500;
  let attempt = 0;
  while (true) {
    try {
      await fn();
      return;
    } catch (err) {
      attempt++;
      if (attempt >= max) throw err;
      const delay = base * 2 ** (attempt - 1);
      await new Promise(res => setTimeout(res, delay));
    }
  }
}