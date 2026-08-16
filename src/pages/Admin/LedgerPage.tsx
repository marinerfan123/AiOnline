// 后台「盈亏看板」（对接后端 /api/admin/ledger/summary）
// 双边账务：后台成本 vs 客户收费 = 平台盈亏。accounting.summarize 聚合 consumption_ledger。
// 此前前端遗漏该页（后端能力已就绪），本次补齐，消除「后端有、前端漏接」缺口。
import { useEffect, useState } from 'react';
import { Scale, ArrowDownCircle, ArrowUpCircle, Wallet } from 'lucide-react';
import { PageHeader, SectionCard, StatCard, cn } from '@/components/skeleton';
import { apiAdminLedgerSummary } from '@/services/api';

interface LedgerRow {
  scope: string;
  purpose: string;
  calls: number;
  sum_backend: number;
  sum_customer: number;
  sum_margin: number;
}
interface LedgerSummary {
  total: { backendCostCents: number; customerChargeCents: number; marginCents: number };
  byScopePurpose: LedgerRow[];
}

function yuan(cents: number): string {
  return `¥${(Number(cents) / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function LedgerPage() {
  const [data, setData] = useState<LedgerSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await apiAdminLedgerSummary();
      if (alive && r?.ok) setData({ total: r.total, byScopePurpose: r.byScopePurpose || [] });
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const total = data?.total;
  const rows = data?.byScopePurpose ?? [];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="盈亏看板"
        subtitle="双边账务：后台成本 vs 客户收费 = 平台盈亏（consumption_ledger 聚合）"
        icon={<Scale className="size-5" />}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <StatCard label="后台成本" value={total ? yuan(total.backendCostCents) : '—'} icon={<ArrowDownCircle className="size-4" />} />
        <StatCard label="客户收费" value={total ? yuan(total.customerChargeCents) : '—'} icon={<ArrowUpCircle className="size-4" />} />
        <StatCard
          label="平台盈亏"
          value={total ? yuan(total.marginCents) : '—'}
          icon={<Wallet className="size-4" />}
        />
      </div>

      <SectionCard title="按 scope / purpose 明细" hint={`共 ${rows.length} 条`} bodyClassName="p-0">
        {loading ? (
          <div className="p-6 text-sm text-zinc-500">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-zinc-500">暂无账务数据</div>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-zinc-950 text-zinc-400">
                <tr className="border-b border-zinc-800">
                  <th className="px-4 py-3 font-medium">scope</th>
                  <th className="px-4 py-3 font-medium">purpose</th>
                  <th className="px-4 py-3 text-right font-medium">调用次数</th>
                  <th className="px-4 py-3 text-right font-medium">后台成本</th>
                  <th className="px-4 py-3 text-right font-medium">客户收费</th>
                  <th className="px-4 py-3 text-right font-medium">盈亏</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {rows.map((r, i) => (
                  <tr key={i} className="hover:bg-white/5">
                    <td className="px-4 py-2.5 text-zinc-300">{r.scope}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{r.purpose || '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-zinc-200">{r.calls}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-zinc-300">{yuan(r.sum_backend)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-zinc-300">{yuan(r.sum_customer)}</td>
                    <td
                      className={cn(
                        'px-4 py-2.5 text-right tabular-nums font-medium',
                        r.sum_margin >= 0 ? 'text-emerald-300' : 'text-rose-300',
                      )}
                    >
                      {yuan(r.sum_margin)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
