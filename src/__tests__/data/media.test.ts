/**
 * 测试 data/media.ts - IMediaItem 接口和 Mock 数据
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

// 直接引入数据模块 (HANFU_PROMPT 是私有常量，不可导入)
import { MOCK_MEDIA_LIST } from '../../data/media.ts';
import type { IMediaItem } from '../../data/media.ts';

describe('data/media.ts', () => {
  describe('MOCK_MEDIA_LIST', () => {
    it('should contain 6 mock media items', () => {
      assert.strictEqual(MOCK_MEDIA_LIST.length, 6);
    });

    it('each item should have required fields', () => {
      for (const item of MOCK_MEDIA_LIST) {
        assert.ok(typeof item.id === 'string', `Item ${item.id}: missing id`);
        assert.ok(typeof item.title === 'string', `Item ${item.id}: missing title`);
        assert.ok(
          item.type === 'image' || item.type === 'video',
          `Item ${item.id}: invalid type`
        );
        assert.ok(typeof item.thumbnail === 'string', `Item ${item.id}: missing thumbnail`);
        assert.ok(typeof item.fullUrl === 'string', `Item ${item.id}: missing fullUrl`);
        assert.ok(typeof item.prompt === 'string', `Item ${item.id}: missing prompt`);
        assert.ok(typeof item.model === 'string', `Item ${item.id}: missing model`);
        assert.ok(typeof item.ratio === 'string', `Item ${item.id}: missing ratio`);
        assert.ok(typeof item.createdAt === 'string', `Item ${item.id}: missing createdAt`);
        assert.ok(typeof item.isFavorite === 'boolean', `Item ${item.id}: missing isFavorite`);
        assert.ok(typeof item.isDeleted === 'boolean', `Item ${item.id}: missing isDeleted`);
        assert.ok(
          item.source === 'mock' || item.source === 'user',
          `Item ${item.id}: invalid source`
        );
      }
    });

    it('should have unique IDs', () => {
      const ids = MOCK_MEDIA_LIST.map((item) => item.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, ids.length, 'IDs should be unique');
    });

    it('should have valid dates in descending order', () => {
      const dates = MOCK_MEDIA_LIST.map((item) => new Date(item.createdAt).getTime());
      for (let i = 1; i < dates.length; i++) {
        assert.ok(dates[i] <= dates[i - 1], 'Dates should be in descending order');
      }
    });

    it('should have valid ratios', () => {
      const validRatios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
      for (const item of MOCK_MEDIA_LIST) {
        assert.ok(validRatios.includes(item.ratio), `Invalid ratio: ${item.ratio}`);
      }
    });

    it('should have at least one favorite item', () => {
      const favorites = MOCK_MEDIA_LIST.filter((item) => item.isFavorite);
      assert.ok(favorites.length > 0, 'Should have at least one favorite');
    });

    it('all items should have source === "mock"', () => {
      for (const item of MOCK_MEDIA_LIST) {
        assert.strictEqual(item.source, 'mock', `Item ${item.id} should be mock`);
      }
    });

    it('all items should not be deleted', () => {
      for (const item of MOCK_MEDIA_LIST) {
        assert.strictEqual(item.isDeleted, false, `Item ${item.id} should not be deleted`);
      }
    });

    it('should have thumbnail URLs matching the expected pattern', () => {
      for (const item of MOCK_MEDIA_LIST) {
        assert.ok(
          item.thumbnail.includes('/runtime/api/v1/storage/object/'),
          `Item ${item.id}: invalid thumbnail URL pattern`
        );
      }
    });
  });

  describe('IMediaItem type validation', () => {
    it('should correctly identify image vs video types', () => {
      const imageItems = MOCK_MEDIA_LIST.filter((item) => item.type === 'image');
      assert.ok(imageItems.length > 0, 'Should have image items');
      // All mock items are images
      assert.strictEqual(imageItems.length, MOCK_MEDIA_LIST.length);
    });

    it('should have valid category values when present', () => {
      const validCategories = ['image', 'character', 'scene', 'prop', 'other', 'upload'];
      for (const item of MOCK_MEDIA_LIST) {
        if (item.category) {
          assert.ok(
            validCategories.includes(item.category),
            `Invalid category: ${item.category}`
          );
        }
      }
    });
  });
});
