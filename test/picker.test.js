import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHintLines, filterPickerOptions, formatPickerOption, getPickerWindow } from '../src/core/prompt_input.js';
import { renderBanner, renderMascot, renderSessionPrompt } from '../src/core/ui.js';
import { stripAnsi } from '../src/core/ui.js';

test('startup banner no longer uses the legacy framed panel', () => {
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(' '));
  try {
    renderBanner({
      sessionId: 'ses_test_session_1234567890',
      mode: 'build',
      model: 'default-gateway/Elaina-Free',
      gitBranch: 'main'
    });
  } finally {
    console.log = originalLog;
  }

  const rendered = stripAnsi(output.join('\n'));
  assert.match(rendered, /NEXUSCODE/);
  assert.ok(rendered.includes('default-gateway/Elaina-Free'));
  assert.match(rendered, /SESSION/);
  assert.match(rendered, /main/);
  assert.match(rendered, /Ready when you are/);
  assert.match(rendered, /•ᴗ•/);
  assert.equal(renderMascot('idle').length, 3);
  assert.doesNotMatch(rendered, /╭|╰|│/);
});

test('session prompt uses a compact status rail that stays within terminal width', () => {
  for (const columns of [40, 48, 60, 80, 120]) {
    const frame = renderSessionPrompt({
      mode: 'build',
      gitBranch: 'feature/very-long-branch-name',
      model: 'default-gateway/Elaina-Free-with-a-long-model-id',
      columns
    });
    const headerLine = stripAnsi(frame.header).trim();
    assert.ok(headerLine.length <= columns - 4, 'prompt rail should not wrap');
    assert.match(stripAnsi(frame.arrow), /›/);
    assert.doesNotMatch(stripAnsi(frame.header), /╭|╰|│/);
  }
});

test('slash command suggestions are bounded to terminal height and width', () => {
  const matches = Array.from({ length: 24 }, (_, index) => ({
    cmd: '/command-' + index,
    cat: index % 2 ? 'System' : 'Provider',
    desc: 'A deliberately long command description that should be clipped to the terminal width.'
  }));

  const lines = buildHintLines('/command', matches, 12, { columns: 48, rows: 16 });
  assert.ok(lines.length <= 12);
  for (const line of lines) {
    assert.ok(stripAnsi(line).length <= 46, 'suggestion line should fit terminal width');
  }
  assert.match(stripAnsi(lines.join('\n')), /more above/);
  assert.match(stripAnsi(lines.join('\n')), /more below/);
});

test('picker viewport keeps the selected result visible and clamps to list bounds', () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ id: 'item-' + index }));

  const middle = getPickerWindow(items, 12, 6);
  assert.equal(middle.start, 9);
  assert.equal(middle.end, 15);
  assert.equal(middle.items.length, 6);
  assert.equal(middle.selectedIndex, 12);
  assert.ok(middle.items.some(item => item.id === 'item-12'));

  const first = getPickerWindow(items, -4, 6);
  assert.equal(first.start, 0);
  assert.equal(first.selectedIndex, 0);

  const last = getPickerWindow(items, 200, 6);
  assert.equal(last.end, 20);
  assert.equal(last.selectedIndex, 19);
  assert.equal(last.hasBelow, false);
});

test('picker viewport handles empty and shorter-than-page lists', () => {
  assert.deepEqual(getPickerWindow([], 4, 6), {
    start: 0, end: 0, items: [], selectedIndex: -1, hasAbove: false, hasBelow: false
  });

  const short = getPickerWindow([{ id: 'only' }], 5, 6);
  assert.equal(short.start, 0);
  assert.equal(short.end, 1);
  assert.equal(short.selectedIndex, 0);
  assert.equal(short.items.length, 1);
});

test('provider and model picker rows stay within terminal width', () => {
  const option = {
    label: 'nvidia/nemotron-3.5-lightning-ultra-long-model-identifier',
    desc: 'https://gateway.example.com/v1/models/provider/model?debug=very-long-query-string',
    status: 'CONNECTED'
  };

  for (const width of [40, 48, 60, 76, 100]) {
    const line = formatPickerOption(option, { index: 2, selected: true, width });
    assert.equal(stripAnsi(line).length, width, `row should fit exactly within ${width} columns`);
  }
});

test('picker rows keep the right edge aligned when no description or status exists', () => {
  for (const width of [40, 60, 80]) {
    const line = formatPickerOption({ label: 'Custom provider' }, { width });
    assert.equal(stripAnsi(line).length, width);
  }
});

test('search keeps provider and model identity and original option index', () => {
  const options = [
    { label: 'Gemini Flash', desc: 'gemini/gemini-3.7-flash', category: 'Google Gemini' },
    { label: 'DeepSeek V4', desc: 'deepseek/deepseek-v4', category: 'DeepSeek' },
    { label: 'Nemotron Free', desc: 'mallss-nexus-route/nemotron-free', category: 'Mallss Nexus Route' }
  ];

  const results = filterPickerOptions(options, 'nemotron');
  assert.equal(results.length, 1);
  assert.equal(results[0].index, 2);
  assert.equal(results[0].option.label, 'Nemotron Free');
});
