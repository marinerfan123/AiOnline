// M05-A — Studio Node Library (left rail).
// DERIVED FROM THE NODE REGISTRY — never hardcoded node components.
// Supports: search, category collapse, click-to-add, drag-to-canvas.

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import {
  CATEGORY_ORDER,
  NODE_DEFS_LIST,
  type NodeDef,
} from './registry';
import type { StudioNodeKind } from './types';
import { NodeIcon } from './NodeIcon';
import { Input } from '@/shared/ui/v2/Input';
import { cn } from '@/lib/utils';

interface NodeLibraryProps {
  onAdd: (kind: StudioNodeKind) => void;
}

function LibraryItem({ def, onAdd }: { def: NodeDef; onAdd: (k: StudioNodeKind) => void }) {
  return (
    <button
      type="button"
      data-test={`node-library-item-${def.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-studio-node-kind', def.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onAdd(def.id)}
      title={def.description}
      className="group flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-ml2-border hover:bg-ml2-surface-2"
    >
      <span className="mt-px grid size-6 shrink-0 place-items-center rounded bg-ml2-surface-3 text-ml2-text-2 group-hover:text-ml2-accent">
        <NodeIcon name={def.icon} className="size-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-ml2-text">{def.title}</span>
        <span className="mt-0.5 block line-clamp-2 text-[10px] leading-snug text-ml2-text-3">{def.description}</span>
      </span>
    </button>
  );
}

export function NodeLibrary({ onAdd }: NodeLibraryProps) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return CATEGORY_ORDER.map((cat) => ({
      cat,
      defs: NODE_DEFS_LIST.filter(
        (d) =>
          d.category === cat &&
          (!q || d.title.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)),
      ),
    })).filter((g) => g.defs.length > 0);
  }, [search]);

  const toggle = (cat: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  return (
    <aside
      data-test="studio-node-library"
      className="flex h-full w-48 shrink-0 flex-col border-r border-ml2-border bg-ml2-surface-1 2xl:w-56"
    >
      <div className="border-b border-ml2-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ml2-text-3" />
          <Input
            data-test="node-library-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索节点…"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-[11px] text-ml2-text-3">没有匹配的节点</p>
        )}
        {groups.map(({ cat, defs }) => {
          const isCollapsed = collapsed.has(cat);
          return (
            <div key={cat} className="mb-1">
              <button
                type="button"
                data-test={`node-library-category-${cat}`}
                onClick={() => toggle(cat)}
                className="flex w-full items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-ml2-text-3 hover:text-ml2-text-2"
              >
                {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                {cat}
              </button>
              {!isCollapsed && (
                <div className="flex flex-col gap-0.5 py-0.5">
                  {defs.map((def) => (
                    <LibraryItem key={def.id} def={def} onAdd={onAdd} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={cn('border-t border-ml2-border px-2 py-1.5 text-[10px] text-ml2-text-3')}>
        拖拽或点击添加 · 节点来自 Node Registry
      </div>
    </aside>
  );
}
