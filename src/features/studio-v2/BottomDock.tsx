// M05-A — Bottom Dock shell.
// Tabs are RESERVED placeholders (Shots/Timeline/Runs/Versions) for later
// Studio phases. No fake functionality is implemented — each panel states
// explicitly which phase it lands in.

import { useState } from 'react';
import { Clapperboard, ListVideo, PlaySquare, History } from 'lucide-react';
import { cn } from '@/lib/utils';

const TABS = [
  { id: 'shots', label: 'Shots', icon: Clapperboard, phase: 'M05-D 镜头工作流' },
  { id: 'timeline', label: 'Timeline', icon: ListVideo, phase: 'M05-D 时间线' },
  { id: 'runs', label: 'Runs', icon: PlaySquare, phase: 'M05-C Studio Run Engine' },
  { id: 'versions', label: 'Versions', icon: History, phase: 'M05-C Canvas 版本' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function BottomDock() {
  const [active, setActive] = useState<TabId | null>(null);
  const tab = TABS.find((t) => t.id === active) ?? null;

  if (!tab) {
    return (
      <div
        data-test="studio-bottom-dock"
        className="flex h-9 shrink-0 items-center gap-1 border-t border-ml2-border bg-ml2-surface-1 px-2"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            data-test={`dock-tab-${t.id}`}
            onClick={() => setActive(t.id)}
            title={`${t.label} — ${t.phase}`}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium text-ml2-text-3 hover:bg-ml2-surface-3 hover:text-ml2-text-2"
          >
            <t.icon className="size-3.5" />
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-ml2-text-3">Coming in next Studio phases</span>
      </div>
    );
  }

  return (
    <div
      data-test="studio-bottom-dock"
      className="flex h-24 shrink-0 flex-col border-t border-ml2-border bg-ml2-surface-1"
    >
      <div className="flex items-center gap-1 px-2 pt-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            data-test={`dock-tab-${t.id}`}
            onClick={() => setActive(t.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium',
              active === t.id
                ? 'bg-ml2-surface-3 text-ml2-text'
                : 'text-ml2-text-3 hover:bg-ml2-surface-3 hover:text-ml2-text-2',
            )}
          >
            <t.icon className="size-3.5" />
            {t.label}
          </button>
        ))}
        <button
          data-test="dock-close"
          onClick={() => setActive(null)}
          aria-label="收起 Dock"
          className="ml-auto rounded p-1 text-ml2-text-3 hover:bg-ml2-surface-3 hover:text-ml2-text"
        >
          <span className="block text-sm leading-none">×</span>
        </button>
      </div>
      <div className="grid flex-1 place-items-center px-3">
        <p className="text-[11px] text-ml2-text-3">
          <span className="font-medium text-ml2-text-2">{tab.label}</span> — {tab.phase} 提供。
          本阶段（M05-A）仅建立 Dock 结构，不实现该功能。
        </p>
      </div>
    </div>
  );
}
