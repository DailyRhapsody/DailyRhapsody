import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../components/pet/PetChatPanel.tsx', import.meta.url), 'utf8');

test('retry action stays icon-only and accessible in a narrow chat panel', () => {
  const action = source.match(/\{chat\.error\.retryable && \(\s*(<button[\s\S]*?<\/button>)\s*\)\}/)?.[1];
  assert.ok(action, 'retry button must remain conditional on retryable');
  assert.match(action, /onClick=\{chat\.retry\}/);
  assert.match(action, /aria-label="重试"/);
  assert.match(action, /shrink-0/);
  assert.match(action, /<svg[\s\S]*?<path/);
  assert.doesNotMatch(action, />\s*重试\s*</);
});
