// M05-A/B2 — Studio Node Library (left rail).
// DERIVED FROM THE NODE REGISTRY — never hardcoded node components.
// M05-B2: production sections (INPUT / CREATIVE / GENERATE / MEDIA / OUTPUT /
// STRUCTURE) computed from def.executionKind + def.category via
// librarySectionOf — one source of truth (the registry).
// Supports: search, section collapse, click-to-add, drag-to-canvas.

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Layers3, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import {
  LIBRARY_SECTIONS,
  NODE_DEFS_LIST,
  librarySectionOf,
  type NodeDef,
} from './registry';
import type { StudioNodeKind } from './types';
import { NodeIcon } from './NodeIcon';
import { Input } from '@/shared/ui/v2/Input';
import { cn } from '@/lib/utils';

interface NodeLibraryProps {
  onAdd: (kind: StudioNodeKind) => void;
}

function LibraryItem({ def, onAdd, compact = false }: { def: NodeDef; onAdd: (k: StudioNodeKind) => void; compact?: boolean }) {
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
      aria-label={compact ? def.title : undefined}
      className={cn('studio-library-item group flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-ml2-border hover:bg-ml2-surface-2', compact && 'justify-center px-1')}
    >
      <span className="studio-library-icon mt-px grid size-7 shrink-0 place-items-center rounded-lg bg-ml2-surface-3 text-ml2-text-2 group-hover:text-ml2-accent">
        <NodeIcon name={def.icon} className="size-3.5" />
      </span>
      {!compact && <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-ml2-text">{def.title}</span>
        <span className="mt-0.5 block line-clamp-2 text-[10px] leading-snug text-ml2-text-3">{def.description}</span>
      </span>}
    </button>
  );
}

export function NodeLibrary({ onAdd }: NodeLibraryProps) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(true);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return LIBRARY_SECTIONS.map((sec) => ({
      sec,
      defs: NODE_DEFS_LIST.filter(
        (d) =>
          librarySectionOf(d) === sec.id &&
          (!q || d.title.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)),
      ),
    })).filter((g) => g.defs.length > 0);
  }, [search]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <aside
      data-test="studio-node-library"
      className={cn('studio-rail studio-node-library flex h-full shrink-0 flex-col border-r border-ml2-border bg-ml2-surface-1', expanded ? 'is-expanded w-52 2xl:w-60' : 'is-collapsed w-14')}
    >
      <div className={cn('studio-rail-header border-b border-ml2-border px-3 pb-3 pt-3', !expanded && 'px-2')}>
        <div className={cn('flex items-center justify-between', expanded ? 'mb-3' : 'mb-0 justify-center')}>
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-ml2-accent/15 text-ml2-accent">
              <Layers3 className="size-3.5" />
            </span>
            {expanded && <div>
              <p className="text-xs font-semibold text-ml2-text">节点库</p>
              <p className="text-[10px] text-ml2-text-3">拖入画布开始创作</p>
            </div>}
          </div>
          {expanded && <span className="rounded-full bg-ml2-surface-3 px-2 py-0.5 text-[10px] text-ml2-text-3">{NODE_DEFS_LIST.length}</span>}
          <button
            type="button"
            data-test="node-library-toggle"
            aria-label={expanded ? '收起节点库' : '展开节点库'}
            title={expanded ? '收起节点库' : '展开节点库'}
            onClick={() => setExpanded((value) => !value)}
            className={cn('grid size-7 place-items-center rounded-lg text-ml2-text-3 hover:bg-ml2-surface-3 hover:text-ml2-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ml2-accent/70', expanded && 'ml-1')}
          >
            {expanded ? <PanelLeftClose className="size-3.5" /> : <PanelLeftOpen className="size-3.5" />}
          </button>
        </div>
        {expanded && <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ml2-text-3" />
          <Input
            data-test="node-library-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索节点…"
            className="h-7 pl-7 text-xs"
          />
        </div>}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-[11px] text-ml2-text-3">没有匹配的节点</p>
        )}
        {groups.map(({ sec, defs }) => {
          const isCollapsed = collapsed.has(sec.id);
          return (
            <div key={sec.id} className="studio-library-section mb-1">
              {expanded && <button
                type="button"
                data-test={`node-library-category-${sec.id}`}
                onClick={() => toggle(sec.id)}
                className="studio-section-toggle flex w-full items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-ml2-text-3 hover:text-ml2-text-2"
              >
                {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                {sec.label}
              </button>}
              {!isCollapsed && (
                <div className="flex flex-col gap-0.5 py-0.5">
                  {defs.map((def) => (
                    <LibraryItem key={def.id} def={def} onAdd={onAdd} compact={!expanded} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {expanded && <div className="studio-rail-footer border-t border-ml2-border px-3 py-2 text-[10px] text-ml2-text-3">
          拖拽或点击添加 · 节点来自 Node Registry
        </div>}
    </aside>
  );
}
