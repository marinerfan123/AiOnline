import { X, Grid3X3, Volume2, Mic, Eye, Eraser } from 'lucide-react';
import { useState } from 'react';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

type ToggleKey =
  | 'hoverSound'
  | 'silentVideo'
  | 'showBlockDetails'
  | 'clearPromptAfterSubmit';

export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const [viewMode, setViewMode] = useState<'grid' | 'batch'>('grid');
  const [gridSize, setGridSize] = useState<'S' | 'M' | 'L'>('M');
  const [toggles, setToggles] = useState<Record<ToggleKey, boolean>>({
    hoverSound: false,
    silentVideo: false,
    showBlockDetails: false,
    clearPromptAfterSubmit: true,
  });

  if (!open) return null;

  const toggleItems: { key: ToggleKey; icon: typeof Volume2; label: string }[] = [
    { key: 'hoverSound', icon: Volume2, label: '光标悬停时播放声音' },
    { key: 'silentVideo', icon: Mic, label: '返回无声视频' },
    { key: 'showBlockDetails', icon: Eye, label: '显示功能块详细信息' },
    { key: 'clearPromptAfterSubmit', icon: Eraser, label: '提交后清除提示' },
  ];

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-4 top-16 z-50 w-72 rounded-[2rem] bg-zinc-900/95 backdrop-blur-xl p-5 border border-zinc-800">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">设置</h3>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-2xl text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 视图模式 */}
        <div className="mb-5">
          <div className="mb-2.5 text-xs font-bold uppercase tracking-widest text-zinc-500">视图模式</div>
          <div className="grid grid-cols-2 gap-1.5 rounded-2xl bg-zinc-800/50 p-1.5">
            {(['grid', 'batch'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className={`flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm transition-all duration-300 ${
                  viewMode === mode
                    ? 'bg-emerald-500/15 text-emerald-400 font-semibold'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Grid3X3 className="size-4" />
                <span>{mode === 'grid' ? '网格' : '批量'}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 网格大小 */}
        <div className="mb-5">
          <div className="mb-2.5 text-xs font-bold uppercase tracking-widest text-zinc-500">网格大小</div>
          <div className="grid grid-cols-3 gap-1.5 rounded-2xl bg-zinc-800/50 p-1.5">
            {(['S', 'M', 'L'] as const).map((size) => (
              <button
                key={size}
                onClick={() => setGridSize(size)}
                className={`rounded-xl py-2.5 text-sm font-semibold transition-all duration-300 ${
                  gridSize === size
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        {/* 开关列表 */}
        <div className="space-y-1">
          {toggleItems.map((item) => {
            const Icon = item.icon;
            const on = toggles[item.key];
            return (
              <button
                key={item.key}
                onClick={() => setToggles((prev) => ({ ...prev, [item.key]: !prev[item.key] }))}
                className="flex w-full items-center justify-between gap-3 rounded-2xl px-3 py-3 hover:bg-zinc-800/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Icon className="size-4 text-zinc-500" />
                  <span className="text-sm text-white">{item.label}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className={on ? 'text-zinc-500' : 'text-white font-semibold'}>
                    已关闭
                  </span>
                  <span className={on ? 'text-emerald-400 font-semibold' : 'text-zinc-500'}>
                    已开启
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
