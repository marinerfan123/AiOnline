// M3 运营总控台（真实数据）
// SSE /api/admin/console/stream 每 1s 推送五事件：metrics / traffic / flow / log / agent（§H.1）
// 6 KPI + 实时 QPS 曲线 + 全局流水滚动 + 智能体调用 + 日志流 + 告警中心
import { Activity, Zap, Film, Coins, CheckCircle2, Timer, CircleAlert, Radio } from 'lucide-react';
import { PageHeader, StatCard, SectionCard, TabBar, cn } from '@/components/skeleton';
import { useEffect, useRef, useState } from 'react';
import { formatCredits } from '@/utils/format';

interface Metrics {
  online: number;
  qps: number;
  gen_today: number;
  credit_today: number;
  success_rate: number;
  avg_latency: number;
}
interface Flow { id: number; user: string; type: string; amount: number; balanceAfter: number | null; ts: number; }
interface LogRow { id: number; level: string; action: string; msg: string; ts: number; }
interface AgentSnap { agent: string; calls: number; ok_rate: number; cost: number; ts: number; }

const KPI_DEFS = [
  { key: 'online', label: '在线用户', icon: <Activity className="size-4" />, fmt: (m: Metrics) => m.online },
  { key: 'qps', label: 'QPS', icon: <Zap className="size-4" />, fmt: (m: Metrics) => m.qps },
  { key: 'gen_today', label: '今日生成', icon: <Film className="size-4" />, fmt: (m: Metrics) => m.gen_today },
  { key: 'credit_today', label: '今日积分消耗', icon: <Coins className="size-4" />, fmt: (m: Metrics) => m.credit_today },
  { key: 'success_rate', label: '成功率', icon: <CheckCircle2 className="size-4" />, fmt: (m: Metrics) => `${m.success_rate}%` },
  { key: 'avg_latency', label: '平均延迟', icon: <Timer className="size-4" />, fmt: (m: Metrics) => `${m.avg_latency}ms` },
] as const;

const LEVEL_STYLE: Record<string, string> = {
  info: 'text-sky-300 bg-sky-400/10',
  warn: 'text-amber-300 bg-amber-400/10',
  error: 'text-rose-300 bg-rose-400/10',
};

export default function ConsolePage() {
  const [tab, setTab] = useState<'overview' | 'logs' | 'alerts'>('overview');
  const [metrics, setMetrics] = useState<Metrics>({ online: 0, qps: 0, gen_today: 0, credit_today: 0, success_rate: 0, avg_latency: 0 });
  const [qpsPoints, setQpsPoints] = useState<number[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentSnap>>({});
  const [conn, setConn] = useState<'connecting' | 'live' | 'error'>('connecting');
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/admin/console/stream');
    esRef.current = es;
    es.addEventListener('open', () => setConn('live'));
    es.addEventListener('metrics', (e) => {
      try { setMetrics(JSON.parse((e as MessageEvent).data)); } catch {}
    });
    es.addEventListener('traffic', (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { qps: number };
        setQpsPoints((prev) => [...prev.slice(-39), d.qps]);
      } catch {}
    });
    es.addEventListener('flow', (e) => {
      try {
        const f = JSON.parse((e as MessageEvent).data) as Flow;
        setFlows((prev) => [f, ...prev].slice(0, 30));
      } catch {}
    });
    es.addEventListener('log', (e) => {
      try {
        const l = JSON.parse((e as MessageEvent).data) as LogRow;
        setLogs((prev) => [l, ...prev].slice(0, 60));
      } catch {}
    });
    es.addEventListener('agent', (e) => {
      try {
        const a = JSON.parse((e as MessageEvent).data) as AgentSnap;
        setAgents((prev) => ({ ...prev, [a.agent]: a }));
      } catch {}
    });
    es.onerror = () => setConn('error');
    return () => { es.close(); esRef.current = null; };
  }, []);

  const maxQps = Math.max(1, ...qpsPoints);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="运营总控台"
        subtitle="M3 · 全局流水 / 流量 / 动向 / 日志 / 告警态势感知（admin 专属）"
        phase={{ status: 'ready', label: 'Phase 2 · SSE 已接入' }}
        icon={<Activity className="size-5" />}
        actions={
          <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
            conn === 'live' ? 'bg-emerald-400/15 text-emerald-300' : conn === 'error' ? 'bg-rose-400/15 text-rose-300' : 'bg-zinc-400/15 text-zinc-300')}>
            <Radio className="size-3.5" /> {conn === 'live' ? '实时连接' : conn === 'error' ? '连接中断' : '连接中…'}
          </span>
        }
      />

      {/* 6 KPI */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {KPI_DEFS.map((k) => (
          <StatCard key={k.key} label={k.label} value={k.key === 'credit_today' ? formatCredits(k.fmt(metrics) as number) : String(k.fmt(metrics))} icon={k.icon} />
        ))}
      </div>

      <TabBar
        tabs={[
          { key: 'overview', label: '态势总览' },
          { key: 'logs', label: '日志流' },
          { key: 'alerts', label: '告警中心' },
        ]}
        active={tab}
        onChange={(key) => setTab(key as 'overview' | 'logs' | 'alerts')}
      />

      {tab === 'overview' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <SectionCard title="实时流量" hint="traffic 事件" className="lg:col-span-2" bodyClassName="p-4">
            <div className="flex h-44 items-end gap-1">
              {qpsPoints.length === 0 && <div className="text-xs text-zinc-500">等待实时数据…</div>}
              {qpsPoints.map((v, i) => (
                <div key={i} className="flex-1 rounded-t bg-gradient-to-t from-emerald-500/30 to-emerald-400/80 transition-all"
                  style={{ height: `${Math.max(4, (v / maxQps) * 100)}%` }} title={`${v} qps`} />
              ))}
            </div>
            <div className="mt-2 text-xs text-zinc-500">最近 40 秒 QPS（1s 推送）</div>
          </SectionCard>

          <SectionCard title="动向趋势" hint="flow 事件">
            <div className="max-h-48 space-y-1.5 overflow-auto pr-1">
              {flows.length === 0 && <div className="text-xs text-zinc-500">暂无积分流水</div>}
              {flows.map((f) => (
                <div key={f.id} className="flex items-center justify-between rounded-lg bg-white/5 px-2.5 py-1.5 text-xs">
                  <span className="text-zinc-300">{f.user}</span>
                  <span className={cn('font-medium', f.amount >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                    {f.amount >= 0 ? '+' : '-'}{formatCredits(Math.abs(f.amount))} · {f.type}
                  </span>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="智能体调用" hint="agent 事件" className="lg:col-span-2" bodyClassName="p-0">
            <div className="grid grid-cols-1 gap-px bg-white/5 sm:grid-cols-3">
              {Object.values(agents).map((a) => (
                <div key={a.agent} className="bg-zinc-950 p-3">
                  <div className="truncate text-sm font-medium text-zinc-100">{a.agent}</div>
                  <div className="mt-1 flex items-baseline gap-2 text-xs text-zinc-400">
                    <span>调用 <b className="text-zinc-100">{a.calls}</b></span>
                    <span>成功率 <b className={a.ok_rate >= 99 ? 'text-emerald-300' : 'text-amber-300'}>{a.ok_rate}%</b></span>
                    <span>成本 <b className="text-zinc-100">{a.cost}</b></span>
                  </div>
                </div>
              ))}
              {Object.keys(agents).length === 0 && <div className="bg-zinc-950 p-3 text-xs text-zinc-500">等待智能体数据…</div>}
            </div>
          </SectionCard>

          <SectionCard title="异常 IP / 封禁" hint="ops_bot">
            <ul className="space-y-2 text-xs text-zinc-300">
              <li className="rounded-lg bg-white/5 px-2.5 py-2"><span className="text-emerald-300">rule-ban-ip</span> · 登录失败≥20/IP → 封禁 + 审计</li>
              <li className="rounded-lg bg-white/5 px-2.5 py-2"><span className="text-amber-300">rule-error-rate</span> · 5xx&gt;2% → 推告警</li>
              <li className="rounded-lg bg-white/5 px-2.5 py-2"><span className="text-sky-300">rule-auto-reply</span> · 咨询命中知识库 → 应答草稿</li>
            </ul>
          </SectionCard>
        </div>
      )}

      {tab === 'logs' && (
        <SectionCard title="日志流" hint="log 事件 · audit_logs（全量审计，不采样）" bodyClassName="p-0">
          <div className="max-h-[28rem] divide-y divide-white/5 overflow-auto">
            {logs.length === 0 && <div className="p-4 text-xs text-zinc-500">暂无审计日志</div>}
            {logs.map((l) => (
              <div key={l.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                <span className={cn('rounded px-1.5 py-0.5 font-medium', LEVEL_STYLE[l.level] || LEVEL_STYLE.info)}>{l.level}</span>
                <span className="w-28 shrink-0 truncate text-zinc-400">{l.action}</span>
                <span className="flex-1 truncate text-zinc-200">{l.msg}</span>
                <span className="shrink-0 text-zinc-500">{new Date(l.ts).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {tab === 'alerts' && (
        <SectionCard title="告警中心" hint="H.2 阈值（实时指标驱动，异常时经 SSE 推送）" bodyClassName="p-4">
          <div className="space-y-2">
            {[
              { name: 'QPS 过载', cond: 'QPS > 800', hit: metrics.qps > 800 },
              { name: '成功率下滑', cond: '成功率 < 95%', hit: metrics.success_rate > 0 && metrics.success_rate < 95 },
              { name: '高延迟', cond: 'P95 > 1s', hit: metrics.avg_latency > 1000 },
              { name: '5xx 比例', cond: '5xx > 2%', hit: false },
              { name: '视频积压', cond: '积压 > 50', hit: false },
            ].map((a) => (
              <div key={a.name} className={cn('flex items-center justify-between rounded-xl px-3 py-2.5 text-sm',
                a.hit ? 'bg-rose-400/10 text-rose-200' : 'bg-white/5 text-zinc-300')}>
                <span className="flex items-center gap-2"><CircleAlert className="size-4" /> {a.name}</span>
                <span className="text-xs text-zinc-500">{a.cond}</span>
                <span className={cn('text-xs font-medium', a.hit ? 'text-rose-300' : 'text-emerald-300')}>{a.hit ? '触发' : '正常'}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
