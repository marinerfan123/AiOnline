// 积分流水（真实数据）
// credit_transactions：本人流水查询 + 后台审计；balance_after 只追加对账。
import { Receipt } from 'lucide-react';
import { PageHeader, SectionCard, cn } from '@/components/skeleton';
import { useCallback, useEffect, useState } from 'react';
import { apiAdminTransactions, type AdminTx } from '@/services/api';
import { formatCredits } from '@/utils/format';

const TYPE_OPTS = [
  { v: '', label: '全部类型' },
  { v: 'grant', label: '发放' },
  { v: 'reserve', label: '预占' },
  { v: 'commit', label: '确认' },
  { v: 'release', label: '释放' },
  { v: 'adjust', label: '后台调整' },
];

const TYPE_STYLE: Record<string, string> = {
  grant: 'text-sky-300 bg-sky-400/10',
  reserve: 'text-amber-300 bg-amber-400/10',
  commit: 'text-emerald-300 bg-emerald-400/10',
  release: 'text-rose-300 bg-rose-400/10',
  adjust: 'text-violet-300 bg-violet-400/10',
};

export default function TransactionsPage() {
  const [items, setItems] = useState<AdminTx[]>([]);
  const [total, setTotal] = useState(0);
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiAdminTransactions({ type: type || undefined, limit: 100 });
    setItems(r.items);
    setTotal(r.total);
    setLoading(false);
  }, [type]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="积分流水"
        subtitle="M2 · 消费 / 充值 / 后台调整 / 退款流水；balance_after 只追加对账"
        phase={{ status: 'ready', label: 'Phase 2 · 真实数据' }}
        icon={<Receipt className="size-5" />}
        actions={<span className="rounded-2xl bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300">共 {total} 条</span>}
      />

      <div className="flex flex-wrap gap-2">
        {TYPE_OPTS.map((t) => (
          <button
            key={t.v}
            onClick={() => setType(t.v)}
            className={cn('rounded-2xl px-3 py-1.5 text-sm transition-colors',
              type === t.v ? 'bg-emerald-500 text-black' : 'bg-white/5 text-zinc-300 hover:bg-white/10')}
          >
            {t.label}
          </button>
        ))}
      </div>

      <SectionCard title="credit_transactions" hint="user_id / kind / amount / balance_after / ref / created_at">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="py-2 pr-4 font-medium">用户</th>
                <th className="py-2 pr-4 font-medium">类型</th>
                <th className="py-2 pr-4 font-medium">变动</th>
                <th className="py-2 pr-4 font-medium">余额快照</th>
                <th className="py-2 pr-4 font-medium">关联</th>
                <th className="py-2 font-medium">时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {loading && <tr><td colSpan={6} className="py-6 text-center text-xs text-zinc-500">加载中…</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-xs text-zinc-500">暂无流水</td></tr>}
              {!loading && items.map((t) => (
                <tr key={t.id} className="text-zinc-200">
                  <td className="py-2.5 pr-4 text-zinc-300">{t.user}</td>
                  <td className="py-2.5 pr-4">
                    <span className={cn('rounded-full px-2 py-0.5 text-xs', TYPE_STYLE[t.kind] || 'bg-white/10 text-zinc-300')}>{t.kind}</span>
                    <span className={cn('ml-1 rounded-full px-1.5 py-0.5 text-[10px]', t.pool === 'reward' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400')}>
                      {t.pool === 'reward' ? '赠送' : '充值'}
                    </span>
                  </td>
                  <td className={cn('py-2.5 pr-4 font-medium', t.amount >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                    {t.amount >= 0 ? '+' : '-'}{formatCredits(Math.abs(t.amount))}
                  </td>
                  <td className="py-2.5 pr-4 text-zinc-400">{t.balanceAfter == null ? '—' : formatCredits(t.balanceAfter)}</td>
                  <td className="py-2.5 pr-4 max-w-[12rem] truncate text-xs text-zinc-500">{t.ref || '—'}</td>
                  <td className="py-2.5 text-xs text-zinc-500">{new Date(t.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
