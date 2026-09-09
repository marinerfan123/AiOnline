import { describe, expect, it } from 'vitest';
import { MODEL_HUB_NAV_GROUPS, type ModelHubTab } from './ModelHubNavigation';

describe('ModelHubNavigation information architecture', () => {
  it('groups resources, runtime routing, and infrastructure without mixing concerns', () => {
    expect(MODEL_HUB_NAV_GROUPS.map((group) => group.label)).toEqual([
      '模型资源',
      '调用与编排',
      '基础设施',
    ]);

    const tabs = MODEL_HUB_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    expect(tabs).toEqual<ModelHubTab[]>(['models', 'providers', 'endpoints', 'pairing', 'storage']);
  });

  it('uses task-oriented names and marks the non-runtime pairing surface as experimental', () => {
    const items = MODEL_HUB_NAV_GROUPS.flatMap((group) => group.items);
    expect(items.find((item) => item.id === 'endpoints')).toMatchObject({ label: '接口协议' });
    expect(items.find((item) => item.id === 'pairing')).toMatchObject({ label: '模型协作', badge: '实验' });
  });
});
