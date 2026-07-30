/**
 * A failure-safe FIFO for local LLM requests.
 *
 * CPU-only Ollama normally evaluates one prompt efficiently at a time. Sending
 * one request per bot concurrently makes every request count time spent waiting
 * inside Ollama against its timeout. This queue keeps that waiting outside the
 * request timeout and prevents one rejected task from poisoning later work.
 */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const localLlmQueue = new SerialTaskQueue();
