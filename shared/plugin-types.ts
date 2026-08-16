// ---- plugin:workbench_text_to_image_1 ----
// ============================================================
// 插件 workbench_text_to_image_1 (创作工作台文生图插件) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface WorkbenchTextToImageOneInput {
  /** 图片生成的核心主题内容描述 */
  subject: string;
  /** 图片比例，可选值：1:1、4:3、3:4、16:9、9:16、3:2、2:3，默认1:1 */
  image_ratio?: string;
  /** 图片风格、构图、光影等附加生成要求（可选） */
  style_requirements?: string;
}

/**
 * capabilityClient.load('workbench_text_to_image_1').call<WorkbenchTextToImageOneOutput>('textToImage', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { images } = result;
 */
export interface WorkbenchTextToImageOneOutput {
  /** [object Object] */
  images: string[];
}
// ---- end:workbench_text_to_image_1 ----

// ---- plugin:ancient_style_portrait_prompt_optimizer_1 ----
// ============================================================
// 插件 ancient_style_portrait_prompt_optimizer_1 (古风人像提示词优化器) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface AncientStylePortraitPromptOptimizerOneInput {
  /** 用户输入的古风人像简单描述 */
  simple_description: string;
  /** 用户额外的风格或细节要求（可选） */
  additional_requirements?: string;
}

/**
 * capabilityClient.load('ancient_style_portrait_prompt_optimizer_1').call<AncientStylePortraitPromptOptimizerOneOutput>('textGenerate', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { content, response } = result;
 */
export interface AncientStylePortraitPromptOptimizerOneOutput {
  /** [object Object] */
  content: string;
  /** [object Object] */
  response?: string;
}
// ---- end:ancient_style_portrait_prompt_optimizer_1 ----