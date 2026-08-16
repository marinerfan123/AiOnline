/**
 * 测试 data/settings.ts - IGenerationSettings 接口和默认值
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../../data/settings.ts';
import type { IGenerationSettings } from '../../data/settings.ts';

describe('data/settings.ts', () => {
  describe('DEFAULT_SETTINGS', () => {
    it('should have default contentType as "image"', () => {
      assert.strictEqual(DEFAULT_SETTINGS.contentType, 'image');
    });

    it('should have default ratio as "16:9"', () => {
      assert.strictEqual(DEFAULT_SETTINGS.ratio, '16:9');
    });

    it('should have default model as "Nano Banana 2 Lite"', () => {
      assert.strictEqual(DEFAULT_SETTINGS.model, 'Nano Banana 2 Lite');
    });

    it('should have default count as 1', () => {
      assert.strictEqual(DEFAULT_SETTINGS.count, 1);
    });

    it('should have valid contentType', () => {
      assert.ok(
        DEFAULT_SETTINGS.contentType === 'image' || DEFAULT_SETTINGS.contentType === 'video'
      );
    });

    it('should have valid ratio value', () => {
      const validRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
      assert.ok(validRatios.includes(DEFAULT_SETTINGS.ratio));
    });

    it('should have valid count in range 1-4', () => {
      assert.ok(DEFAULT_SETTINGS.count >= 1 && DEFAULT_SETTINGS.count <= 4);
    });
  });

  describe('IGenerationSettings type', () => {
    it('should allow valid settings object', () => {
      const settings: IGenerationSettings = {
        contentType: 'image',
        ratio: '1:1',
        model: 'Nano Banana Pro',
        count: 2,
      };
      assert.strictEqual(settings.contentType, 'image');
      assert.strictEqual(settings.ratio, '1:1');
      assert.strictEqual(settings.model, 'Nano Banana Pro');
      assert.strictEqual(settings.count, 2);
    });

    it('should allow optional duration field', () => {
      const settings: IGenerationSettings = {
        contentType: 'video',
        ratio: '16:9',
        model: 'Sora',
        count: 1,
        duration: 8,
      };
      assert.strictEqual(settings.duration, 8);
    });

    it('should allow optional videoMode field', () => {
      const settings: IGenerationSettings = {
        contentType: 'video',
        ratio: '9:16',
        model: 'Kling',
        count: 1,
        videoMode: 'i2v_first',
      };
      assert.strictEqual(settings.videoMode, 'i2v_first');
    });
  });
});
