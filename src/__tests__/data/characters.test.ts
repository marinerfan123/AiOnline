/**
 * 测试 data/characters.ts - ICharacter 接口和 Mock 数据
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MOCK_CHARACTERS } from '../../data/characters.ts';
import type { ICharacter } from '../../data/characters.ts';

describe('data/characters.ts', () => {
  describe('MOCK_CHARACTERS', () => {
    it('should contain at least 1 mock character', () => {
      assert.ok(MOCK_CHARACTERS.length >= 1);
    });

    it('each character should have required fields', () => {
      for (const char of MOCK_CHARACTERS) {
        assert.ok(typeof char.id === 'string', `Character ${char.id}: missing id`);
        assert.ok(typeof char.name === 'string', `Character ${char.id}: missing name`);
        assert.ok(typeof char.avatar === 'string', `Character ${char.id}: missing avatar`);
        assert.ok(
          typeof char.description === 'string',
          `Character ${char.id}: missing description`
        );
        assert.ok(
          Array.isArray(char.referenceImages),
          `Character ${char.id}: referenceImages should be array`
        );
        assert.ok(
          typeof char.baseModel === 'string',
          `Character ${char.id}: missing baseModel`
        );
        assert.ok(typeof char.createdAt === 'string', `Character ${char.id}: missing createdAt`);
        assert.ok(
          char.source === 'mock' || char.source === 'user',
          `Character ${char.id}: invalid source`
        );
      }
    });

    it('should have unique IDs', () => {
      const ids = MOCK_CHARACTERS.map((c) => c.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, ids.length);
    });

    it('first character should have name "示例角色·青鸾"', () => {
      assert.strictEqual(MOCK_CHARACTERS[0].name, '示例角色·青鸾');
    });

    it('first character should have 3 reference images', () => {
      assert.strictEqual(MOCK_CHARACTERS[0].referenceImages.length, 3);
    });

    it('reference images should be valid URLs', () => {
      for (const char of MOCK_CHARACTERS) {
        for (const img of char.referenceImages) {
          assert.ok(
            img.includes('/runtime/api/v1/storage/object/'),
            'Reference image should use platform storage URL'
          );
        }
      }
    });

    it('should have valid base model', () => {
      for (const char of MOCK_CHARACTERS) {
        assert.ok(char.baseModel.length > 0);
      }
    });

    it('should have valid createdAt date', () => {
      for (const char of MOCK_CHARACTERS) {
        const date = new Date(char.createdAt);
        assert.ok(!isNaN(date.getTime()), `Invalid date: ${char.createdAt}`);
      }
    });

    it('all characters should have source === "mock"', () => {
      for (const char of MOCK_CHARACTERS) {
        assert.strictEqual(char.source, 'mock');
      }
    });
  });
});
