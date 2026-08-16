// EXPORTS: IOssConfig, DEFAULT_OSS_CONFIG, list/active/normalize semantics
//
// 多槽位模型（v2 起支持多个云并存）：
//   • 任意时刻只有一个 active 槽位被「上传」使用
//   • 槽位列表存于后端 oss_configs 表 / oss_configs.json
//   • 总开关 enabled 存于 oss_config(id=1) / oss_settings.json
//
// 支持两种云：
//   • providerType: 'aliyun-oss' —— 阿里云对象存储
//   • providerType: 'tencent-cos' —— 腾讯云对象存储
//
// 注：access_key_id / access_key_secret 在两种云中通用对应（阿里云是 AccessKey/Secret，腾讯云是 SecretId/SecretKey）。

export type OssProviderType = 'aliyun-oss' | 'tencent-cos';

export interface IOssConfig {
  id: string;                    // 槽位唯一 ID，由后端生成或前端自定（slug）
  providerType: OssProviderType;
  displayName: string;           // 用户起的别名，多账号下方便辨识

  bucket: string;
  region: string;                // 阿里云如 cn-shanghai；腾讯云如 ap-shanghai
  regionLabel: string;           // 人读名称 "华东2（上海）"
  appId: string;                 // 仅腾讯云需要（bucket-{appid}.cos.{region}.myqcloud.com 形式）

  accessKeyId: string;           // 阿里云 AccessKeyId / 腾讯云 SecretId
  accessKeySecret: string;       // 阿里云 AccessKeySecret / 腾讯云 SecretKey
  endpointExternal: string;      // 阿里云：oss-cn-shanghai.aliyuncs.com 之类
                                  // 腾讯云：可选保留（不填时自动用 cos.{region}.myqcloud.com）
  pathPrefix: string;            // 默认 images/
  customDomain: string;          // 可选 CDN 域名

  enabled: boolean;              // 单槽位停用（不影响其它槽位）
  createdAt?: string;
}

/**
 * 默认新槽位（用户点击「新增阿里云 OSS」/「新增腾讯云 COS」时）
 */
export const DEFAULT_OSS_SLOT: Omit<IOssConfig, 'id' | 'displayName'> = {
  providerType: 'aliyun-oss',
  bucket: '',
  region: 'cn-shanghai',
  regionLabel: '华东2（上海）',
  appId: '',
  accessKeyId: '',
  accessKeySecret: '',
  endpointExternal: 'oss-cn-shanghai.aliyuncs.com',
  pathPrefix: 'images/',
  customDomain: '',
  enabled: true,
};

/**
 * 新槽位预填（仅用于类型兼容；启动时由 useOssConfig 的首次 GET 推回）
 * @deprecated 用 API 拉回的数据
 */
export const DEFAULT_OSS_CONFIG: IOssConfig = {
  id: '__default__',
  providerType: 'aliyun-oss',
  displayName: '默认',
  bucket: '',
  region: 'cn-shanghai',
  regionLabel: '华东2（上海）',
  appId: '',
  accessKeyId: '',
  accessKeySecret: '',
  endpointExternal: 'oss-cn-shanghai.aliyuncs.com',
  pathPrefix: 'images/',
  customDomain: '',
  enabled: true,
};
