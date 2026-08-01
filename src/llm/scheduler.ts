/** A failure-safe FIFO for local LLM requests with bounded queue residence. */
export class LlmQueueWaitTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`LLM_QUEUE_WAIT_TIMED_OUT:${waitedMs}`);
    this.name = "LlmQueueWaitTimeoutError";
  }
}

/** Strategic plans remain useful while waiting for the single local model.
 * Urgent reactions expire quickly; optional limits still apply to auxiliary calls. */
export function queueWaitLimitFor(label: string, configuredMaxMs: number): number | undefined {
  if (label === "strategic") return undefined;
  if (label === "reactive") return Math.min(5_000, configuredMaxMs > 0 ? configuredMaxMs : 5_000);
  return configuredMaxMs > 0 ? configuredMaxMs : undefined;
}

export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: (queueWaitMs: number) => Promise<T>, options: { maxQueueWaitMs?: number } = {}): Promise<T> {
    const queuedAt = Date.now();
    let expired = false;
    const scheduled = this.tail.then(
      async () => {
        const queueWaitMs = Date.now() - queuedAt;
        if (expired || (options.maxQueueWaitMs !== undefined && queueWaitMs >= options.maxQueueWaitMs)) {
          throw new LlmQueueWaitTimeoutError(queueWaitMs);
        }
        return task(queueWaitMs);
      },
      async () => {
        const queueWaitMs = Date.now() - queuedAt;
        if (expired || (options.maxQueueWaitMs !== undefined && queueWaitMs >= options.maxQueueWaitMs)) {
          throw new LlmQueueWaitTimeoutError(queueWaitMs);
        }
        return task(queueWaitMs);
      },
    );
    this.tail = scheduled.then(
      () => undefined,
      () => undefined,
    );

    if (options.maxQueueWaitMs === undefined) return scheduled;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        expired = true;
        reject(new LlmQueueWaitTimeoutError(Date.now() - queuedAt));
      }, options.maxQueueWaitMs);
      timer.unref?.();
      scheduled.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

export const localLlmQueue = new SerialTaskQueue();
