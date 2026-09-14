// src/data/modelConfigs/schema.ts
// 视频模型能力集权威类型。由 video-model-config-agent 技能生成草稿时使用。
// ⚠️ 本目录 / 本类型仅用于【视频模型】配置。提取阶段若发现非视频模型
//   （图像 / 文本，如 SeedDream=image）应排除并标 NEEDS_CONFIRM，不写入此目录。
// 人工确认后，supportedParams 会被并入 models 表的 supported_params / param_template。
// 此文件为「草稿模块」的一部分，不依赖任何运行时逻辑，可单独存在、随 safe-git 提交。

export type VideoQuality = 'low' | 'standard' | 'high' | (string & {});
export type VideoMode =
  | 't2v' // 文生视频
  | 'i2v_first' // 图生视频（首帧）
  | 'i2v_first_last' // 首尾帧
  | 'reference_image' // 参考图
  | 'keyframes' // 关键帧
  | (string & {});

export interface VideoSupportedParams {
  /** 质量档：low / standard / high，或其它文档自定义值 */
  qualities?: VideoQuality[];
  /** 画幅比例；文档说任意画幅则填 ['any'] */
  ratios?: string[];
  /** 时长（秒）；-1 表示「智能/auto」时长 */
  durationsSec?: number[];
  /** 视频生成模式 */
  videoModes?: VideoMode[];
  /** 分辨率档位，原样保留文档档位名（480p/720p/1080p/4k/1k/2k） */
  videoResolutions?: string[];
  /** 参考图 / 关键帧数量上限 */
  maxReferenceImages?: number;
  /** 推荐帧率 fps */
  frameRate?: number;
  /** 最大帧数（用于推算最长时长） */
  maxNumFrames?: number;
}

export interface VideoModelConfig {
  /** 上游模型标识（必填，唯一） */
  modelId: string;
  /** 对外映射名（可选） */
  displayName?: string;
  /** 通常挂在哪个 provider（可选） */
  providerId?: string;
  /** 系列名（Agnes / Seedance / SeedEdit ...） */
  officialFamily?: string;
  /** 官方文档链接（可选） */
  docsUrl?: string;
  /** 能力集（必填） */
  supportedParams: VideoSupportedParams;
  /** 来源/推断依据；NEEDS_CONFIRM 必须写明原因 */
  notes?: string;
}
