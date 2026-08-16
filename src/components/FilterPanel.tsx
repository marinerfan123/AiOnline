import { useState } from 'react';
import { Filter, X } from 'lucide-react';

interface FilterPanelProps {
  open: boolean;
  onClose: () => void;
  resultCount: number;
}

export default function FilterPanel({ open, onClose, resultCount }: FilterPanelProps) {
  const [types, setTypes] = useState<string[]>([]);
  const [ratios, setRatios] = useState<string[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [durations, setDurations] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<'newest' | 'oldest'>('newest');

  if (!open) return null;

  const toggle = (arr: string[], setArr: (v: string[]) => void, val: string) => {
    if (arr.includes(val)) {
      setArr(arr.filter((v) => v !== val));
    } else {
      setArr([...arr, val]);
    }
  };

  const Checkbox = ({
    checked,
    onChange,
    label,
  }: {
    checked: boolean;
    onChange: () => void;
    label: string;
  }) => (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <div
        onClick={onChange}
        className={`flex h-4 w-4 items-center justify-center rounded-md border transition-all duration-300 ${
          checked ? 'border-emerald-500 bg-emerald-500' : 'border-zinc-700 hover:border-zinc-600'
        }`}
      >
        {checked && (
          <svg className="size-3 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <span className="text-sm text-white">{label}</span>
    </label>
  );

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute right-16 top-16 z-40 w-80 rounded-[2rem] bg-zinc-900/95 backdrop-blur-xl border border-zinc-800 overflow-hidden">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <Filter className="size-4 text-emerald-400" />
            <h3 className="text-sm font-bold text-white">过滤条件</h3>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-2xl text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5 space-y-6">
          {/* 类型 + 宽高比 */}
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="mb-3 text-xs font-bold uppercase tracking-widest text-zinc-500">类型</div>
              <div className="space-y-2.5">
                {['图片', '角色', '视频', '场景', '道具', '其他'].map((t) => (
                  <Checkbox
                    key={t}
                    checked={types.includes(t)}
                    onChange={() => toggle(types, setTypes, t)}
                    label={t}
                  />
                ))}
              </div>
            </div>
            <div>
              <div className="mb-3 text-xs font-bold uppercase tracking-widest text-zinc-500">宽高比</div>
              <div className="space-y-2.5">
                {['横向', '纵向', '自由格式'].map((r) => (
                  <Checkbox
                    key={r}
                    checked={ratios.includes(r)}
                    onChange={() => toggle(ratios, setRatios, r)}
                    label={r}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="h-px bg-zinc-800" />

          {/* 创建日期 + 时长 */}
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="mb-3 text-xs font-bold uppercase tracking-widest text-zinc-500">创建日期</div>
              <div className="space-y-2.5">
                {['已生成', '已上传', '收藏'].map((d) => (
                  <Checkbox
                    key={d}
                    checked={dates.includes(d)}
                    onChange={() => toggle(dates, setDates, d)}
                    label={d}
                  />
                ))}
              </div>
            </div>
            <div>
              <div className="mb-3 text-xs font-bold uppercase tracking-widest text-zinc-500">时长</div>
              <div className="space-y-2.5">
                {['4秒', '6秒', '8秒', '10s'].map((d) => (
                  <Checkbox
                    key={d}
                    checked={durations.includes(d)}
                    onChange={() => toggle(durations, setDurations, d)}
                    label={d}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="h-px bg-zinc-800" />

          {/* 排序方式 */}
          <div>
            <div className="mb-3 text-xs font-bold uppercase tracking-widest text-zinc-500">排序方式</div>
            <div className="space-y-1.5">
              {(['newest', 'oldest'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSortBy(s)}
                  className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 transition-all duration-300 ${
                    sortBy === s ? 'bg-emerald-500/10 border border-emerald-500/20' : 'hover:bg-zinc-800/50 border border-transparent'
                  }`}
                >
                  <div
                    className={`h-4 w-4 rounded-full border-2 flex items-center justify-center transition-all duration-300 ${
                      sortBy === s ? 'border-emerald-500' : 'border-zinc-700'
                    }`}
                  >
                    {sortBy === s && <div className="h-2 w-2 rounded-full bg-emerald-500" />}
                  </div>
                  <span className="text-sm text-white">{s === 'newest' ? '最新' : '最早'}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 底部结果数 */}
        <div className="border-t border-zinc-800 px-5 py-4">
          <span className="text-sm font-semibold text-emerald-400">{resultCount} 条结果</span>
        </div>
      </div>
    </>
  );
}
