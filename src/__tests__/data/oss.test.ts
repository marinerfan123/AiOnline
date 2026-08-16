/**
 * 测试 data/oss.ts - OSS 配置类型和默认配置
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_OSS_CONFIG, DEFAULT_OSS_SLOT } from '../../data/oss.ts';
import type { IOssConfig, OssProviderType } from '../../data/oss.ts';

describe('data/oss.ts', () => {
  describe('DEFAULT_OSS_CONFIG', () => {
    it('should have providerType "aliyun-oss"', () => {
      assert.strictEqual(DEFAULT_OSS_CONFIG.providerType, 'aliyun-oss');
    });

    it('should have required string fields', () => {
      const fields = [
        'displayName',
        'endpointExternal',
        'bucket',
        'region',
        'regionLabel',
      ] as const;
      for (const field of fields) {
        assert.ok(
          typeof DEFAULT_OSS_CONFIG[field] === 'string',
          `Field "${field}" should be a string`
        );
        assert.ok(DEFAULT_OSS_CONFIG[field].length > 0, `Field "${field}" should not be empty`);
      }
    });

    it('should have empty access keys by default', () => {
      assert.strictEqual(DEFAULT_OSS_CONFIG.accessKeyId, '');
      assert.strictEqual(DEFAULT_OSS_CONFIG.accessKeySecret, '');
    });

    it('should have pathPrefix "images/"', () => {
      assert.strictEqual(DEFAULT_OSS_CONFIG.pathPrefix, 'images/');
    });

    it('should have region "cn-shanghai"', () => {
      assert.strictEqual(DEFAULT_OSS_CONFIG.region, 'cn-shanghai');
    });
  });

  describe('DEFAULT_OSS_SLOT', () => {
    it('defaults to aliyun-oss', () => {
      assert.strictEqual(DEFAULT_OSS_SLOT.providerType, 'aliyun-oss');
      assert.strictEqual(DEFAULT_OSS_SLOT.region, 'cn-shanghai');
      assert.strictEqual(DEFAULT_OSS_SLOT.endpointExternal, 'oss-cn-shanghai.aliyuncs.com');
    });

    it('has empty secrets (user must fill in)', () => {
      assert.strictEqual(DEFAULT_OSS_SLOT.accessKeyId, '');
      assert.strictEqual(DEFAULT_OSS_SLOT.accessKeySecret, '');
      assert.strictEqual(DEFAULT_OSS_SLOT.bucket, '');
    });
  });

  describe('OssProviderType union', () => {
    it('includes both clouds', () => {
      const a: OssProviderType = 'aliyun-oss';
      const t: OssProviderType = 'tencent-cos';
      assert.ok(a && t);
    });
  });

  describe('IOssConfig type', () => {
    it('should accept tencent-cos config', () => {
      const cfg: IOssConfig = {
        id: 'oss-test',
        providerType: 'tencent-cos',
        displayName: 'shanghai',
        bucket: 'huabu-1250000000',
        region: 'ap-shanghai',
        regionLabel: '上海',
        appId: '1250000000',
        accessKeyId: 'AKID...',
        accessKeySecret: 'xxx',
        endpointExternal: 'cos.ap-shanghai.myqcloud.com',
        pathPrefix: 'uploads/',
        customDomain: '',
        enabled: true,
      };
      assert.strictEqual(cfg.providerType, 'tencent-cos');
      assert.strictEqual(cfg.appId, '1250000000');
    });
  });
});
