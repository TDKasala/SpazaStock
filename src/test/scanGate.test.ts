import { describe, it, expect } from 'vitest';
import { createScanGate } from '../lib/scanGate';
import { createSerialQueue } from '../lib/serialQueue';

/** Reads the camera would report for one code held in frame at `fps` for `ms`. */
function holdInFrame(gate: ReturnType<typeof createScanGate>, code: string, start: number, ms: number, fps = 15) {
  let accepted = 0;
  const step = 1000 / fps;
  for (let t = start; t < start + ms; t += step) if (gate.accept(code, t)) accepted++;
  return accepted;
}

describe('scan gate', () => {
  it('counts an item held in front of the camera once', () => {
    const gate = createScanGate(1200);
    expect(holdInFrame(gate, '6001007300123', 0, 3000)).toBe(1);
  });

  it('counts the item again after it has left the frame and come back', () => {
    const gate = createScanGate(1200);
    expect(holdInFrame(gate, '6001007300123', 0, 1000)).toBe(1);
    // Out of sight for 1.5s, then presented again.
    expect(holdInFrame(gate, '6001007300123', 2500, 1000)).toBe(1);
  });

  it('does not let a long hold leak extra scans when reads arrive just inside the window', () => {
    const gate = createScanGate(1200);
    let accepted = 0;
    for (let t = 0; t <= 10_000; t += 1100) if (gate.accept('A', t)) accepted++;
    expect(accepted).toBe(1);
  });

  it('accepts a different code immediately, so alternating items all count', () => {
    const gate = createScanGate(1200);
    const codes = ['A', 'B', 'A', 'B', 'C'];
    expect(codes.filter((code, i) => gate.accept(code, i * 100))).toEqual(codes);
  });

  it('ignores blank reads and forgets everything on reset', () => {
    const gate = createScanGate(1200);
    expect(gate.accept('   ', 0)).toBe(false);
    expect(gate.accept('A', 0)).toBe(true);
    gate.reset();
    expect(gate.accept('A', 10)).toBe(true);
  });
});

describe('serial queue', () => {
  it('runs tasks one at a time in arrival order', async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = (name: string, ms: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`end ${name}`);
      running--;
      return name;
    };

    const results = await Promise.all([queue.run(task('a', 20)), queue.run(task('b', 1)), queue.run(task('c', 5))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(maxRunning).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('keeps going after a task fails and reports the failure to its caller', async () => {
    const queue = createSerialQueue();
    const failing = queue.run(async () => {
      throw new Error('boom');
    });
    const next = queue.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.size).toBe(0);
  });
});
