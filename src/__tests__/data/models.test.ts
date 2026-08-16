/**
 * 测试 data/models.ts - 模型和服务商类型及工具函数
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MOCK_MODELS,
  MOCK_PROVIDERS,
  PROVIDER_TEMPLATES,
  defaultEstimatedSeconds,
  defaultCategory,
  defaultCommercialUse,
  getEffectiveModelName,
} from '../../data/models.ts';

describe('data/models.ts', () => {
  describe('MOCK_MODELS / MOCK_PROVIDERS / PROVIDER_TEMPLATES', () => {
    it('should be empty arrays in production (no placeholder providers/models)', () => {
      assert.strictEqual(MOCK_MODELS.length, 0, 'MOCK_MODELS should be empty');
      assert.strictEqual(MOCK_PROVIDERS.length, 0, 'MOCK_PROVIDERS should be empty');
      assert.strictEqual(PROVIDER_TEMPLATES.length, 0, 'PROVIDER_TEMPLATES should be empty');
    });
  });

  describe('defaultEstimatedSeconds', () => {
    it('returns sensible defaults by type', () => {
      assert.strictEqual(defaultEstimatedSeconds('image'), 20);
      assert.strictEqual(defaultEstimatedSeconds('video'), 40);
      assert.strictEqual(defaultEstimatedSeconds('text'), 8);
    });
  });

  describe('defaultCategory', () => {
    it('returns category labels by type', () => {
      assert.strictEqual(defaultCategory('image'), '通用');
      assert.strictEqual(defaultCategory('video'), '创意');
      assert.strictEqual(defaultCategory('text'), '推理');
    });
  });

  describe('defaultCommercialUse', () => {
    it('allows commercial use for image/video, disallows for text', () => {
      assert.strictEqual(defaultCommercialUse('image'), true);
      assert.strictEqual(defaultCommercialUse('video'), true);
      assert.strictEqual(defaultCommercialUse('text'), false);
    });
  });

  describe('getEffectiveModelName', () => {
    it('prefers mappingName over displayName', () => {
      assert.strictEqual(
        getEffectiveModelName({ displayName: 'DALL·E 3', mappingName: '自定义名' }),
        '自定义名'
      );
    });

    it('falls back to displayName when mappingName is empty', () => {
      assert.strictEqual(getEffectiveModelName({ displayName: 'DALL·E 3', mappingName: '' }), 'DALL·E 3');
      assert.strictEqual(getEffectiveModelName({ displayName: 'DALL·E 3' }), 'DALL·E 3');
    });

    it('returns empty string for null/undefined', () => {
      assert.strictEqual(getEffectiveModelName(null), '');
      assert.strictEqual(getEffectiveModelName(undefined), '');
    });
  });
});
