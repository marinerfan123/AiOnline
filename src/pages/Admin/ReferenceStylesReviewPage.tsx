// 后台：参考样式审核（AI 预审 + 人工终审）
// 仅管理员可访问。AI 只做建议，最终 approve/reject 必须由人工点击确认。
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Check, X, Loader2, AlertTriangle, Search, Eye, User, Calendar, Filter,
} from 'lucide-react';
import Image from '@/components/ui/image';
import {
  apiAdminGetReferenceStyles,
  apiAdminReviewReferenceStyle,
  apiAdminPromoteReferenceStyle,
  type ReferenceStyle,
} from '@/services/api';

const STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待 AI 预审' },
  { value: 'ai_flagged', label: 'AI 标记（需人工）' },
  { value: 'ai_passed', label: 'AI 通过（待人工）' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已拒绝' },
];

const STATUS_BADGE: Record<string, { text: string; class: string }> = {
  pending: { text: '待 AI 预审', class: 'bg-zinc-800 text-zinc-400' },
  ai_flagged: { text: 'AI 标记', class: 'bg-amber-500/15 text-amber-400' },
  ai_passed: { text: 'AI 通过', class: 'bg-blue-500/15 text-blue-400' },
  approved: { text: '已通过', class: 'bg-emerald-500/15 text-emerald-400' },
  rejected: { text: '已拒绝', class: 'bg-rose-500/15 text-rose-400' },
};

const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export default function ReferenceStylesReviewPage() {
  const [items, setItems] = useState<ReferenceStyle[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 10;

  const [reviewing, setReviewing] = useState<ReferenceStyle | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // 推行设置（强制推行 + 分成比例）的本地编辑态，按 id 覆盖
  const [promoteMap, setPromoteMap] = useState<Record<string, { isPromoted: boolean; commissionRate: number }>>({});
  const [busyPromoteId, setBusyPromoteId] = useState<string | null>(null);

  const getPV = (item: ReferenceStyle) =>
    promoteMap[item.id] ?? { isPromoted: !!item.isPromoted, commissionRate: item.commissionRate ?? 0 };
  const setPV = (item: ReferenceStyle, patch: Partial<{ isPromoted: boolean; commissionRate: number }>) =>
    setPromoteMap((m) => ({ ...m, [item.id]: { ...getPV(item), ...patch } }));
  const isDirty = (item: ReferenceStyle) => {
    const v = promoteMap[item.id];
    if (!v) return false;
    return v.isPromoted !== !!item.isPromoted || v.commissionRate !== (item.commissionRate ?? 0);
  };

  const savePromote = async (item: ReferenceStyle) => {
    const v = getPV(item);
    setBusyPromoteId(item.id);
    try {
      const r = await apiAdminPromoteReferenceStyle(item.id, { isPromoted: v.isPromoted, commissionRate: v.commissionRate });
      if (r.ok) {
        toast.success('已更新推行设置');
        setPromoteMap((m) => { const n = { ...m }; delete n[item.id]; return n; });
        await load();
      } else {
        toast.error(r.error || '操作失败');
      }
    } catch (e: any) {
      toast.error('操作失败：' + (e?.message || e));
    } finally {
      setBusyPromoteId(null);
    }
  };

  const load = useCallback(async (opts?: { reset?: boolean }) => {
    setLoading(true);
    try {
      const offset = opts?.reset ? 0 : page * PAGE_SIZE;
      const r = await apiAdminGetReferenceStyles({ status: status || undefined, q: q.trim(), limit: PAGE_SIZE, offset });
      setItems(r.items || []);
      setTotal(r.total || 0);
      if (opts?.reset) setPage(0);
    } catch (e: any) {
      toast.error('加载审核列表失败：' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [status, q, page]);

  useEffect(() => { load({ reset: true }); }, [load]);

  const doReview = async (item: ReferenceStyle, decision: 'approve' | 'reject') => {
    if (decision === 'reject' && !rejectReason.trim()) {
      toast.error('请填写拒绝原因');
      return;
    }
    setBusyId(item.id);
    try {
      const r = await apiAdminReviewReferenceStyle(item.id, decision, rejectReason.trim());
      if (r.ok) {
        toast.success(r.message || (decision === 'approve' ? '已通过' : '已拒绝'));
        setReviewing(null);
        setRejectReason('');
        await load();
      } else {
        toast.error(r.error || '审核失败');
      }
    } catch (e: any) {
      toast.error('审核失败：' + (e?.message || e));
    } finally {
      setBusyId(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-black p-4 text-zinc-100 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        {/* Header */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold">参考样式审核</h1>
            <p className="text-sm text-zinc-500">AI 预审仅作建议，最终决策必须由人工完成</p>
          </div>
          <div className="flex items-center gap-2 rounded-2xl bg-amber-500/10 px-4 py-2 text-xs text-amber-400">
            <AlertTriangle className="size-4" />
            任何模棱两可的内容都应拒绝或要求补充信息
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load({ reset: true })}
              placeholder="搜索样式名称 / 提示词 / 投稿人"
              className="w-full rounded-xl bg-zinc-900 py-2 pl-9 pr-4 text-sm text-zinc-100 placeholder-zinc-600 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="size-4 text-zinc-500" />
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(0); }}
              className="rounded-xl bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none ring-1 ring-zinc-800"
            >
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        </div>

        {/* List */}
        {loading && items.length === 0 ? (
          <div className="flex h-64 items-center justify-center gap-2 text-zinc-500">
            <Loader2 className="size-5 animate-spin" />
            <span>加载中…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-zinc-500">
            <Eye className="size-8 opacity-30" />
            <span>暂无记录</span>
          </div>
        ) : (
          <div className="space-y-4">
            {items.map((item) => {
              const badge = STATUS_BADGE[item.status || 'pending'];
              return (
                <div key={item.id} className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
                  <div className="flex flex-col gap-4 p-4 md:flex-row">
                    {/* Preview */}
                    <div className="shrink-0">
                      <div className="h-32 w-32 overflow-hidden rounded-xl bg-zinc-900">
                        {item.previewUrl ? (
                          <Image src={item.previewUrl} alt={item.name} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-zinc-600">无图</div>
                        )}
                      </div>
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn('rounded-full px-2 py-0.5 text-xs', badge.class)}>{badge.text}</span>
                        {item.isPromoted && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-400">推广中</span>}
                        <h3 className="text-sm font-medium text-zinc-200">{item.name || '未命名样式'}</h3>
                      </div>

                      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                        <span className="flex items-center gap-1"><User className="size-3" /> {item.userDisplayName || item.userEmail || '匿名'}</span>
                        <span className="flex items-center gap-1"><Calendar className="size-3" /> {item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '-'}</span>
                        {item.modelId && <span className="rounded-md bg-zinc-900 px-1.5 py-0.5">{item.modelId}</span>}
                        {item.ratio && <span className="rounded-md bg-zinc-900 px-1.5 py-0.5">{item.ratio}</span>}
                      </div>

                      {item.description && (
                        <p className="text-xs text-zinc-400">{item.description}</p>
                      )}

                      {item.prompt && (
                        <div className="rounded-xl bg-zinc-900/70 p-2.5">
                          <p className="text-[10px] uppercase tracking-wider text-zinc-500">Prompt</p>
                          <p className="mt-0.5 line-clamp-3 text-xs text-zinc-300">{item.prompt}</p>
                        </div>
                      )}

                      {item.aiReason && (
                        <div className={cn(
                          'rounded-xl p-2.5 text-xs',
                          item.status === 'ai_flagged' ? 'bg-amber-500/10 text-amber-400' : 'bg-blue-500/10 text-blue-400',
                        )}>
                          <span className="font-medium">AI 预审：</span>{item.aiReason}
                        </div>
                      )}

                      {item.rejectReason && (
                        <div className="rounded-xl bg-rose-500/10 p-2.5 text-xs text-rose-400">
                          <span className="font-medium">拒绝原因：</span>{item.rejectReason}
                        </div>
                      )}

                      <div className="flex flex-wrap gap-1">
                        {(item.tags || []).map((t) => (
                          <span key={t} className="rounded-md bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400">{t}</span>
                        ))}
                      </div>

                      {/* 推行设置：仅审核通过的样式才可强制推行 + 设置分成比例 */}
                      {item.status === 'approved' && (
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-zinc-900/70 p-2.5 ring-1 ring-zinc-800">
                          <label className="flex items-center gap-2 text-xs text-zinc-300">
                            <input
                              type="checkbox"
                              checked={getPV(item).isPromoted}
                              onChange={(e) => setPV(item, { isPromoted: e.target.checked })}
                              className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 accent-emerald-500"
                            />
                            强制推行（出现在客户工作台示例墙）
                          </label>
                          <div className="flex items-center gap-1.5 text-xs text-zinc-300">
                            <span>设计者分成</span>
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={getPV(item).commissionRate}
                              onChange={(e) => setPV(item, { commissionRate: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                              className="w-16 rounded-lg bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500/50"
                            />
                            <span className="text-zinc-500">%</span>
                          </div>
                          <button
                            disabled={busyPromoteId === item.id || !isDirty(item)}
                            onClick={() => savePromote(item)}
                            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
                          >
                            {busyPromoteId === item.id ? <Loader2 className="size-3.5 animate-spin" /> : '保存推行设置'}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="shrink-0">
                      {(item.status === 'pending' || item.status === 'ai_passed' || item.status === 'ai_flagged') ? (
                        <div className="flex flex-col gap-2">
                          <button
                            disabled={busyId === item.id}
                            onClick={() => doReview(item, 'approve')}
                            className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
                          >
                            {busyId === item.id ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                            通过
                          </button>
                          <button
                            disabled={busyId === item.id}
                            onClick={() => { setReviewing(item); setRejectReason(''); }}
                            className="flex items-center justify-center gap-1.5 rounded-xl bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                          >
                            <X className="size-4" />
                            拒绝
                          </button>
                        </div>
                      ) : (
                        <div className="text-xs text-zinc-500">
                          已终审：{item.reviewedAt ? new Date(item.reviewedAt).toLocaleString('zh-CN') : '-'}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              disabled={page <= 0 || loading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-xl bg-zinc-900 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
            >
              上一页
            </button>
            <span className="text-sm text-zinc-500">{page + 1} / {totalPages}</span>
            <button
              disabled={page >= totalPages - 1 || loading}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="rounded-xl bg-zinc-900 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
            >
              下一页
            </button>
          </div>
        )}
      </div>

      {/* Reject modal */}
      {reviewing && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setReviewing(null)} />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
            <h3 className="text-base font-medium text-zinc-100">拒绝参考样式</h3>
            <p className="mt-1 text-sm text-zinc-500">请填写拒绝原因，投稿者不会看到具体原因。</p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="例如：包含第三方水印 / 涉及真人肖像 / 质量过低 / 内容存疑"
              className="mt-4 min-h-[96px] w-full rounded-xl bg-zinc-900 p-3 text-sm text-zinc-100 placeholder-zinc-600 outline-none ring-1 ring-zinc-800 focus:ring-rose-500/50"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setReviewing(null)}
                className="rounded-xl bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
              >
                取消
              </button>
              <button
                disabled={busyId === reviewing.id}
                onClick={() => doReview(reviewing, 'reject')}
                className="rounded-xl bg-rose-500 px-4 py-2 text-sm font-medium text-white hover:bg-rose-400 disabled:opacity-50"
              >
                {busyId === reviewing.id ? <Loader2 className="size-4 animate-spin" /> : '确认拒绝'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
