import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPickerOptions, formatPickerOption } from '../src/core/prompt_input.js';
import { stripAnsi } from '../src/core/ui.js';

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
