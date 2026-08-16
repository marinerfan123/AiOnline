import { useState } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function CustomerServiceFloat() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* 悬浮按钮 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'fixed bottom-6 right-6 z-[100] flex items-center gap-2 rounded-full px-4 py-3',
          'bg-emerald-500 text-black shadow-lg shadow-emerald-500/20',
          'hover:bg-emerald-400 transition-all active:scale-95'
        )}
        aria-label="联系客服"
      >
        <MessageCircle className="size-5" />
        <span className="text-sm font-medium">客服群</span>
      </button>

      {/* 弹窗 */}
      {open && (
        <div
          className="fixed inset-0 z-[101] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950 p-6 text-center shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute right-3 top-3 rounded-full p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-white transition-colors"
              aria-label="关闭"
            >
              <X className="size-4" />
            </button>

            <h3 className="mb-1 text-lg font-semibold text-white">墨灵AI 用户群</h3>
            <p className="mb-5 text-sm text-zinc-400">
              加群领取 1000 创意金
              <br />
              出现问题加群直接问群主
            </p>

            <div className="mx-auto mb-4 overflow-hidden rounded-xl bg-white p-2">
              <img
                src="/qrcode-customer-service.png"
                alt="墨灵AI 客服群二维码"
                className="h-auto w-full"
              />
            </div>

            <p className="text-xs text-zinc-500">
              微信扫码进群 · 二维码到期请替换 public/qrcode-customer-service.png
            </p>
          </div>
        </div>
      )}
    </>
  );
}
