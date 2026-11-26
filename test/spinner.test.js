import test from 'node:test';
import assert from 'node:assert/strict';
import { Spinner, renderStartupAnimation } from '../src/core/ui.js';

/**
 * Capture every write to process.stdout while fn() runs.
 */
function captureStdout(fn) {
  const writes = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return writes;
}

test('startup animation writes real terminal control sequences and restores the cursor', async () => {
  const writes = [];
  const output = {
    isTTY: true,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    }
  };

  const shown = await renderStartupAnimation({
    output,
    intervalMs: 0,
    sleep: async () => {}
  });

  assert.equal(shown, true);
  assert.equal(writes[0], '\x1b[?25l');
  assert.ok(writes.some(value => value.includes('\r\x1b[K')));
  assert.ok(writes.at(-2).endsWith('\n'));
  assert.equal(writes.at(-1), '\x1b[?25h');
});

test('startup animation is skipped for non-interactive output', async () => {
  const writes = [];
  const output = { write(chunk) { writes.push(String(chunk)); return true; } };
  assert.equal(await renderStartupAnimation({ output, isTTY: false }), false);
  assert.deepEqual(writes, []);
});

test('stop() after streaming must not erase the assistant response line', () => {
  const spinner = new Spinner('thinking');
  const writes = captureStdout(() => {
    spinner.start('thinking');      // turn starts: spinner running
    spinner.stop(true);             // first token arrives (onToken): clears spinner line
    process.stdout.write('Halo. Ada tugas coding apa hari ini?'); // streamed response
    spinner.stop(true);             // turn done (onDone): must NOT clear the response
  });

  const responseIdx = writes.findIndex((w) => w.includes('Halo. Ada tugas coding'));
  assert.notEqual(responseIdx, -1, 'response must be written to stdout');

  const writesAfterResponse = writes.slice(responseIdx + 1);
  assert.ok(
    !writesAfterResponse.some((w) => w.includes('\x1b[K')),
    'no line-clear escape may be emitted after the response text'
  );
});

test('stop() still clears the line while the spinner is running', () => {
  const spinner = new Spinner('working');
  const writes = captureStdout(() => {
    spinner.start('working');
    spinner.stop(true); // spinner owns the line: it must be cleared
  });
  assert.ok(
    writes.some((w) => w.includes('\r\x1b[K')),
    'clear escape expected while spinner was running'
  );
});

test('start() twice does not leak the previous interval', () => {
  const realClearInterval = global.clearInterval;
  const cleared = [];
  global.clearInterval = (timer) => {
    cleared.push(timer);
    return realClearInterval(timer);
  };
  try {
    const spinner = new Spinner('first');
    captureStdout(() => {
      spinner.start('first');
      const firstTimer = spinner.timer;
      spinner.start('second'); // restart while already running
      assert.ok(cleared.includes(firstTimer), 'previous interval must be cleared');
      assert.notEqual(spinner.timer, firstTimer, 'a fresh interval must be installed');
      spinner.stop(false);
    });
  } finally {
    global.clearInterval = realClearInterval;
  }
});
