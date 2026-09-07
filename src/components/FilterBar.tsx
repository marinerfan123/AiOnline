import { useState } from 'react';
import {
  Search,
  Filter,
  Grid3X3,
  LayoutList,
  ChevronDown,
  ArrowDownAZ,
  ArrowDownZA,
} from 'lucide-react';

interface FilterBarProps {
  searchQuery: string;
  onSearchChange: (v: string) => void;
  viewMode: 'grid' | 'batch';
  onViewModeChange: (v: 'grid' | 'batch') => void;
  gridSize: 'S' | 'M' | 'L';
  onGridSizeChange: (v: 'S' | 'M' | 'L') => void;
  filterOpen: boolean;
  onToggleFilter: () => void;
  sortMode?: 'newest' | 'oldest';
  onSortModeChange?: (v: 'newest' | 'oldest') => void;
}

export default function FilterBar({
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  gridSize,
  onGridSizeChange,
  filterOpen,
  onToggleFilter,
  sortMode = 'newest',
  onSortModeChange,
}: FilterBarProps) {
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5 lg:px-6">
      <div className="relative min-w-[180px] flex-1 lg:max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索素材或提示词"
          className="h-9 w-full rounded-md border border-white/[0.08] bg-white/[0.03] pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-white/20 focus:outline-none"
        />
      </div>

      <button
        onClick={onToggleFilter}
        className={`flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition-colors ${
          filterOpen
            ? 'border-white/20 bg-white/[0.07] text-white'
            : 'border-white/[0.08] bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]'
        }`}
      >
        <Filter className="size-4" />
      </button>

      <div className="flex h-9 items-center rounded-md border border-white/[0.08] bg-white/[0.03] p-1">
        <button
          onClick={() => onViewModeChange('grid')}
          className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
            viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'
          }`}
          title="网格视图"
        >
          <Grid3X3 className="size-4" />
        </button>
        <button
          onClick={() => onViewModeChange('batch')}
          className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
            viewMode === 'batch' ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'
          }`}
          title="批量视图"
        >
          <LayoutList className="size-4" />
        </button>
      </div>

      {/* 排序按钮 */}
      {onSortModeChange && (
        <div className="relative">
          <button
            onClick={() => setSortMenuOpen(!sortMenuOpen)}
            className={`flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors ${
              sortMenuOpen
                ? 'border-white/20 bg-white/[0.07] text-white'
                : 'border-white/[0.08] bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]'
            }`}
            title="排序方式"
          >
            {sortMode === 'newest' ? <ArrowDownZA className="size-4" /> : <ArrowDownAZ className="size-4" />}
            <span className="text-xs font-bold">
              {sortMode === 'newest' ? '最新在前' : '最早在前'}
            </span>
            <ChevronDown className="size-3.5 text-zinc-500" />
          </button>
          {sortMenuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setSortMenuOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-32 overflow-hidden rounded-2xl bg-zinc-900 border border-zinc-800 p-1">
                {([
                  { value: 'newest' as const, label: '最新在前', Icon: ArrowDownZA },
                  { value: 'oldest' as const, label: '最早在前', Icon: ArrowDownAZ },
                ]).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      onSortModeChange(opt.value);
                      setSortMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-all duration-200 ${
                      sortMode === opt.value
                        ? 'bg-emerald-500/10 text-emerald-400 font-semibold'
                        : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
                    }`}
                  >
                    <opt.Icon className="size-3.5" />
                    <span className="text-xs">{opt.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="relative">
        <button
          onClick={() => setSizeMenuOpen(!sizeMenuOpen)}
          className="flex h-9 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 text-sm text-zinc-300 transition-colors hover:bg-white/[0.06]"
        >
          <span className="text-xs font-bold">{gridSize}</span>
          <ChevronDown className="size-3.5 text-zinc-500" />
        </button>
        {sizeMenuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setSizeMenuOpen(false)} />
            <div className="absolute right-0 top-full z-40 mt-1 w-24 overflow-hidden rounded-2xl bg-zinc-900 border border-zinc-800">
              {(['S', 'M', 'L'] as const).map((size) => (
                <button
                  key={size}
                  onClick={() => {
                    onGridSizeChange(size);
                    setSizeMenuOpen(false);
                  }}
                  className={`flex w-full items-center justify-center px-3 py-2.5 text-sm transition-all duration-300 ${
                    gridSize === size
                      ? 'bg-emerald-500/10 text-emerald-400 font-semibold'
                      : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
