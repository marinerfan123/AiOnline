import { describe, expect, it } from 'vitest';
import { detectType } from './AddModelDialog';

describe('model type detection', () => {
  it('classifies Seedream image models as image', () => {
    expect(detectType('doubao-seedream-4-5-251128')).toBe('image');
    expect(detectType('doubao-seedream-3-0-t2i')).toBe('image');
  });

  it('classifies Seedance and explicit video models as video', () => {
    expect(detectType('doubao-seedance-1-0-pro')).toBe('video');
    expect(detectType('sora-2')).toBe('video');
    expect(detectType('provider/t2v-model')).toBe('video');
  });

  it('keeps unknown models as text', () => {
    expect(detectType('gpt-5')).toBe('text');
  });
});
