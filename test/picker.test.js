import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPickerOptions, formatPickerOption, getPickerWindow } from '../src/core/prompt_input.js';
import { stripAnsi } from '../src/core/ui.js';

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
