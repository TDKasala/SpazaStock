/**
 * Runs tasks one at a time in the order they were added. Unlike a busy flag, nothing is dropped:
 * a scan that arrives while another is being recorded waits its turn. A failing task does not
 * stop the tasks queued after it.
 */
export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks added but not yet finished. */
  readonly size: number;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let size = 0;
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      size++;
      const result = tail.then(task);
      const settled = result.then(
        () => undefined,
        () => undefined
      );
      tail = settled;
      void settled.then(() => {
        size--;
      });
      return result;
    },
    get size() {
      return size;
    },
  };
}
