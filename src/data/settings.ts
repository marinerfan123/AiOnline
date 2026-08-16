// EXPORTS: IGenerationSettings, DEFAULT_SETTINGS

/** 比例：覆盖常见构图 + 智能(auto) 兜底 */
export type Ratio =
  | 'auto'
  | 'adaptive'
  | '1:1' | '1:2' | '2:1'
  | '9:16' | '16:9'
  | '3:4' | '4:3'
  | '3:2' | '2:3'
  | '5:4' | '4:5'
  | '21:9' | '9:21';

/** 图像质量：低/标准/高（传后端即使未启用也安全） */
export type Quality = 'low' | 'standard' | 'high';

/**
 * 视频生成模式（与具体供应商无关，适配器据此翻译为各家线格式 / role 词汇）。
 * - t2v            文生视频（无参考图）
 * - i2v_first      图生视频（仅首帧）
 * - i2v_first_last 图生视频（首帧 + 末帧）
 * - reference_image 参考图生视频（1+ 张参考图作为风格/主体）
 * 缺省时后端由参考图数量推导（0→t2v, 1→i2v_first, 2→i2v_first_last, 3+→reference_image）。
 */
export type VideoMode = 't2v' | 'i2v_first' | 'i2v_first_last' | 'reference_image';

export interface IGenerationSettings {
  contentType: 'image' | 'video';
  /** 视频模式（仅 contentType='video' 生效）；缺省由后端按参考图数量推导 */
  videoMode?: VideoMode;
  ratio: Ratio;
  /** 图片分辨率档位（image）；视频分辨率存各家真实枚举（如 768P/2K、480p/720p/1080p/4k），故用 string 兼容 */
  resolution: string;
  quality: Quality;
  model: string;
  count: 1 | 2 | 3 | 4;
  duration?: 4 | 6 | 8 | 10;
}

export const DEFAULT_SETTINGS: IGenerationSettings = {
  contentType: 'image',
  ratio: '16:9',
  resolution: '2k',
  quality: 'standard',
  model: 'Nano Banana 2 Lite',
  count: 1,
  duration: 6,
};
