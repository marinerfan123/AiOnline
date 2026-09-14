import { useState } from 'react';
import { Eye, Sparkles } from 'lucide-react';
import Image from '@/components/ui/image';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ReferenceStyle } from '@/services/api';

export function PromotedStylesSection({
  styles,
  onUse,
}: {
  styles: ReferenceStyle[];
  onUse: (style: ReferenceStyle) => void;
}) {
  const [visible, setVisible] = useState(true);
  const [preview, setPreview] = useState<ReferenceStyle | null>(null);

  if (styles.length === 0) return null;

  return (
    <section className="mb-5" data-test="promoted-styles-section">
      <div className="mb-2 flex min-h-7 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
            <Sparkles className="size-3" /> 精选推广
          </span>
          <span className="truncate text-[11px] text-zinc-600">
            {visible ? '点击图片查看大图' : '精选已隐藏'}
          </span>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[11px] text-zinc-500">
          <span>{visible ? '显示精选' : '隐藏精选'}</span>
          <Switch
            aria-label="显示精选推广样式"
            checked={visible}
            onCheckedChange={setVisible}
            className="data-[state=checked]:bg-amber-500"
          />
        </label>
      </div>

      {visible && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10">
          {styles.map((style) => (
            <article
              key={style.id}
              className="group overflow-hidden rounded-xl border border-white/[0.07] bg-zinc-900/65 transition-colors hover:border-amber-500/35"
            >
              <button
                type="button"
                aria-label={`查看${style.name || '未命名样式'}`}
                onClick={() => setPreview(style)}
                className="relative block aspect-[4/3] w-full overflow-hidden bg-zinc-950 text-left"
              >
                {style.previewUrl ? (
                  <Image src={style.previewUrl} alt="" className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
                ) : (
                  <span className="flex h-full items-center justify-center text-zinc-700"><Sparkles className="size-5" /></span>
                )}
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/25 group-hover:opacity-100">
                  <span className="rounded-full bg-black/70 p-1.5 text-white"><Eye className="size-3.5" /></span>
                </span>
              </button>
              <div className="p-2">
                <p className="truncate text-[11px] font-medium text-zinc-200">{style.name || '未命名样式'}</p>
                <p className="mt-0.5 truncate text-[9px] text-zinc-600">{style.userDisplayName || style.userEmail || '匿名设计者'}</p>
                <button
                  type="button"
                  onClick={() => onUse(style)}
                  className="mt-1.5 w-full rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 py-1 text-[10px] font-medium text-amber-300 transition-colors hover:bg-amber-500/20"
                >
                  用此样式创作
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="max-w-3xl overflow-hidden border-zinc-800 bg-zinc-950 p-0 text-zinc-100">
          {preview && (
            <div className="grid max-h-[85vh] md:grid-cols-[minmax(0,1fr)_15rem]">
              <div className="min-h-64 bg-black">
                <Image
                  src={preview.fullUrl || preview.previewUrl}
                  alt={preview.name || '精选样式'}
                  className="h-full max-h-[85vh] w-full object-contain"
                />
              </div>
              <div className="flex flex-col p-5">
                <DialogHeader>
                  <DialogTitle className="pr-6 text-left text-base">{preview.name || '未命名样式'}</DialogTitle>
                  <DialogDescription className="text-left text-xs text-zinc-500">
                    {preview.userDisplayName || preview.userEmail || '匿名设计者'}
                  </DialogDescription>
                </DialogHeader>
                {preview.description && <p className="mt-4 text-xs leading-5 text-zinc-400">{preview.description}</p>}
                {preview.tags?.length ? (
                  <div className="mt-4 flex flex-wrap gap-1">
                    {preview.tags.map((tag) => <span key={tag} className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-500">{tag}</span>)}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => onUse(preview)}
                  className="mt-auto rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-black hover:bg-amber-400"
                >
                  用此样式创作
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
