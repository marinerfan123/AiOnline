// 创作工作室 · 项目数据模型（M5 流水线）
export type StudioProjectType = 'story' | 'commerce' | 'custom';
export type StudioProjectStatus = 'planning' | 'building' | 'ready' | 'live';
export type StudioProjectStage = 'idea' | 'script' | 'storyboard' | 'video' | 'episode';

export interface IStudioProject {
  id: string;
  ownerId: string;
  title: string;
  type: StudioProjectType;
  status: StudioProjectStatus;
  currentStage: StudioProjectStage;
  description?: string;
  coverUrl?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const STAGE_LABEL: Record<StudioProjectStage, string> = {
  idea: '点子孵化',
  script: '剧本',
  storyboard: '分镜',
  video: '视频',
  episode: '剧集',
};

export const TYPE_LABEL: Record<StudioProjectType, string> = {
  story: '故事型',
  commerce: '电商型',
  custom: '自定义',
};

export const STATUS_LABEL: Record<StudioProjectStatus, string> = {
  planning: '规划中',
  building: '开发中',
  ready: '已具备生成能力',
  live: '已上线',
};
