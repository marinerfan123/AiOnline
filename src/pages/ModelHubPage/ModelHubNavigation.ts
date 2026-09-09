import type { LucideIcon } from 'lucide-react';
import { Boxes, Database, FileCode2, Link2, Server } from 'lucide-react';

export type ModelHubTab = 'providers' | 'models' | 'endpoints' | 'pairing' | 'storage';

export interface ModelHubNavItem {
  id: ModelHubTab;
  label: string;
  description: string;
  icon: LucideIcon;
  badge?: string;
}

export interface ModelHubNavGroup {
  label: string;
  items: ModelHubNavItem[];
}

export const MODEL_HUB_NAV_GROUPS: ModelHubNavGroup[] = [
  {
    label: '模型资源',
    items: [
      { id: 'models', label: '模型', description: '能力、参数、价格与上下架', icon: Boxes },
      { id: 'providers', label: '服务商', description: '账号、密钥、容量与线路', icon: Server },
    ],
  },
  {
    label: '调用与编排',
    items: [
      { id: 'endpoints', label: '接口协议', description: '请求格式、响应解析与端点测试', icon: FileCode2 },
      { id: 'pairing', label: '模型协作', description: '配置模型之间的前置处理关系', icon: Link2, badge: '实验' },
    ],
  },
  {
    label: '基础设施',
    items: [
      { id: 'storage', label: '对象存储', description: '共享媒体存储与素材迁移', icon: Database },
    ],
  },
];

export function findModelHubNavItem(tab: ModelHubTab): ModelHubNavItem {
  const item = MODEL_HUB_NAV_GROUPS.flatMap((group) => group.items).find((entry) => entry.id === tab);
  if (!item) throw new Error(`Unknown Model Hub tab: ${tab}`);
  return item;
}
