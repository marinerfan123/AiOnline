import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';

export interface CanvasCommand {
  id: string;
  label: string;
  description: string;
  keywords?: string;
  shortcut?: string;
  icon?: ReactNode;
  action: () => void;
}

interface CanvasCommandPaletteProps {
  open: boolean;
  commands: readonly CanvasCommand[];
  onClose: () => void;
}

export function CanvasCommandPalette({ open, commands, onClose }: CanvasCommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.description} ${command.keywords ?? ''}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!open) {
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
      return;
    }
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const execute = (command: CanvasCommand | undefined) => {
    if (!command) return;
    command.action();
    onClose();
  };

  return (
    <div
      data-test="canvas-command-palette-backdrop"
      className="absolute inset-0 z-[70] flex items-start justify-center bg-black/20 pt-16 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="画布命令面板"
        data-test="canvas-command-palette"
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
            'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ) ?? []);
          if (focusable.length === 0) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        className="w-[min(34rem,calc(100%-2rem))] overflow-hidden rounded-xl border border-ml2-border bg-ml2-surface-1 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-ml2-border px-3">
          <Search className="size-4 shrink-0 text-ml2-text-3" />
          <input
            ref={inputRef}
            data-test="canvas-command-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
              if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, filtered.length - 1)); return; }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); return; }
              if (event.key === 'Enter') { event.preventDefault(); execute(filtered[activeIndex]); }
            }}
            placeholder="搜索节点、视图和操作…"
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-ml2-text outline-none placeholder:text-ml2-text-3 focus-visible:ring-2 focus-visible:ring-ml2-accent/60"
          />
          <kbd className="rounded border border-ml2-border bg-ml2-surface-2 px-1.5 py-0.5 text-[10px] text-ml2-text-3">Esc</kbd>
        </div>

        <div data-test="canvas-command-list" className="max-h-[min(28rem,60vh)] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p data-test="canvas-command-empty" className="px-3 py-8 text-center text-xs text-ml2-text-3">没有匹配的操作</p>
          ) : filtered.map((command, index) => (
            <button
              key={command.id}
              type="button"
              data-test={`canvas-command-${command.id}`}
              data-active={index === activeIndex ? 'true' : 'false'}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => execute(command)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left ${index === activeIndex ? 'bg-ml2-surface-3' : 'hover:bg-ml2-surface-2'}`}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-ml2-surface-2 text-ml2-accent">{command.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-ml2-text">{command.label}</span>
                <span className="block truncate text-[10px] text-ml2-text-3">{command.description}</span>
              </span>
              {command.shortcut && <kbd className="shrink-0 text-[10px] text-ml2-text-3">{command.shortcut}</kbd>}
            </button>
          ))}
        </div>
        <div className="border-t border-ml2-border px-3 py-1.5 text-[10px] text-ml2-text-3">↑↓ 选择 · Enter 执行 · Ctrl/Cmd+K 打开</div>
      </div>
    </div>
  );
}
