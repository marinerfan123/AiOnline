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
    <div className="flex items-center gap-2 px-4 py-3">
      <div className="relative flex-1 max-w-2xl mx-auto">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索"
          className="w-full rounded-full bg-zinc-900 pl-11 pr-4 py-2.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50 transition-colors"
        />
      </div>

      <button
        onClick={onToggleFilter}
        className={`flex items-center gap-2 rounded-full px-4 py-2.5 text-sm transition-all duration-300 ${
          filterOpen
            ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
            : 'bg-zinc-900 text-white border border-zinc-800 hover:border-zinc-700'
        }`}
      >
        <Filter className="size-4" />
      </button>

      <div className="flex items-center rounded-full bg-zinc-900 p-1.5 border border-zinc-800">
        <button
          onClick={() => onViewModeChange('grid')}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-300 ${
            viewMode === 'grid' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-white'
          }`}
          title="网格视图"
        >
          <Grid3X3 className="size-4" />
        </button>
        <button
          onClick={() => onViewModeChange('batch')}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-300 ${
            viewMode === 'batch' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-white'
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
            className={`flex items-center gap-1.5 rounded-full px-4 py-2.5 text-sm border transition-all duration-300 ${
              sortMenuOpen
                ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                : 'bg-zinc-900 text-white border-zinc-800 hover:border-zinc-700'
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
          className="flex items-center gap-1.5 rounded-full bg-zinc-900 px-4 py-2.5 text-sm text-white border border-zinc-800 hover:border-zinc-700 transition-colors"
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
