import { describe, expect, it } from 'vitest';
import { shouldAutoGenerate } from './generationBarBehavior';

describe('generation bar imperative actions', () => {
  it('does not submit when an action is intended to prefill only', () => {
    expect(shouldAutoGenerate(false)).toBe(false);
  });

  it('keeps one-click generation enabled by default', () => {
    expect(shouldAutoGenerate()).toBe(true);
    expect(shouldAutoGenerate(true)).toBe(true);
  });
});
