import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, KeyRound, ShieldCheck, Snowflake, AlertTriangle, Ban } from 'lucide-react';
import {
  apiAdminKeyPoolStatus,
  type KeyPoolStatusPayload, type KeyPoolProvider, type ModelKeyPoolRow, type CoolingKeyInfo,
} from '@/services/api';

// 模型状态页：密钥池内每个模型「待命(可立即生成) / 冷却(429冷却/熔断)」实时态
const REFRESH_MS = 5000;

function PoolBadge({ label, value, tone }: { label: string; value: number; tone: 'green' | 'amber' | 'zinc' }) {
  const c = tone === 'green' ? 'text-emerald-300' : tone === 'amber' ? 'text-amber-300' : 'text-zinc-500';
  return (
    <span className="rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[11px] tabular-nums">
      <span className={c}>{value}</span>
      <span className="ml-1 text-zinc-500">{label}</span>
    </span>
  );
}

function KeyChips({ keys, poolId }: { keys: CoolingKeyInfo[]; poolId: string }) {
  if (!keys.length) return null;
  return (
    <div className="mt-2 flex max-h-28 flex-wrap gap-1 overflow-auto">
      {keys.map((k) => (
        <span key={k.id} className="inline-flex items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">
          <Snowflake size={10} />
          {k.label || k.id.replace(poolId + '-', '').slice(0, 8)}
          <span className="tabular-nums text-amber-400">剩{k.coolingLeftSec}s</span>
          {k.cbState ? <span className="rounded bg-rose-500/20 px-1 text-rose-300">{k.cbState}</span> : null}
        </span>
      ))}
    </div>
  );
}

function PoolCard({ pool }: { pool: KeyPoolProvider }) {
  const p = pool.pool;
  const pct = p.total > 0 ? 100 / p.total : 0;
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-200">
          <KeyRound size={14} className="text-zinc-400" /> {pool.name}
          <span className="text-[10px] text-zinc-500">{pool.keyMasked}</span>
        </span>
        {pool.enabled
          ? <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">已启用</span>
          : <span className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">已停用</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <PoolBadge label="待命" value={p.ready} tone="green" />
        <PoolBadge label="冷却" value={p.cooling} tone="amber" />
        <PoolBadge label="隔离" value={p.isolated} tone="zinc" />
        <PoolBadge label="总数" value={p.total} tone="zinc" />
      </div>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div className="bg-emerald-500" style={{ width: `${p.ready * pct}%` }} />
        <div className="bg-amber-500" style={{ width: `${p.cooling * pct}%` }} />
        <div className="bg-zinc-600" style={{ width: `${p.isolated * pct}%` }} />
      </div>
      <KeyChips keys={pool.coolingKeys} poolId={pool.providerId} />
    </div>
  );
}

function modelStatus(m: ModelKeyPoolRow): { label: string; cls: string; icon?: 'ok' | 'cool' | 'off' } {
  if (!m.enabled) return { label: '已停用', cls: 'bg-zinc-800 text-zinc-400', icon: 'off' };
  if (m.canGenerate) return { label: '待命', cls: 'bg-emerald-500/10 text-emerald-300', icon: 'ok' };
  if (m.coolingKeys > 0) return { label: '冷却中', cls: 'bg-amber-500/10 text-amber-300', icon: 'cool' };
  return { label: '无可用线路', cls: 'bg-rose-500/10 text-rose-300' };
}

function ModelRow({ m }: { m: ModelKeyPoolRow }) {
  const st = modelStatus(m);
  return (
    <tr className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
      <td className="px-3 py-2.5">
        <div className="text-sm text-zinc-200">{m.displayName}</div>
        <div className="font-mono text-[10px] text-zinc-600">{m.modelId}</div>
      </td>
      <td className="px-3 py-2.5 text-xs text-zinc-400">{m.type}</td>
      <td className="px-3 py-2.5">
        {m.providers.length === 0
          ? <span className="text-xs text-zinc-600">无候选提供商</span>
          : <div className="flex flex-col gap-1">
              {m.providers.map((p) => (
                <span key={p.providerId} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-zinc-300">{p.name}</span>
                  <PoolBadge label="待命" value={p.pool.ready} tone="green" />
                  <PoolBadge label="冷却" value={p.pool.cooling} tone="amber" />
                  {p.coolingKeys.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1 text-[10px] text-amber-300">
                      <Snowflake size={9} />{p.coolingKeys.length} 冷却中
                    </span>
                  )}
                </span>
              ))}
            </div>}
      </td>
      <td className="px-3 py-2.5 text-right">
        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] ${st.cls}`}>
          {st.icon === 'ok' ? <ShieldCheck size={11} /> : st.icon === 'cool' ? <Snowflake size={11} /> : st.icon === 'off' ? <Ban size={11} /> : <AlertTriangle size={11} />}
          {st.label}
        </span>
      </td>
    </tr>
  );
}

export default function KeyPoolPage() {
  const [data, setData] = useState<KeyPoolStatusPayload | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const d = await apiAdminKeyPoolStatus();
      if (d) { setData(d); setErr(''); }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const iv = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(iv);
  }, [load]);

  const agg = data?.agg;
  const lastRefresh = data ? new Date(data.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—';

  return (
    <div className="mx-auto max-w-6xl p-6">
      {/* 头部 */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <KeyRound size={18} className="text-emerald-400" /> 模型状态
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">密钥池实时态：每把 key 待命（可立即生成）或冷却（429 冷却 / 熔断），每 {REFRESH_MS / 1000}s 自动刷新</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>更新于 {lastRefresh}</span>
          <button
            onClick={() => { setLoading(true); load(); }}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-800/80 px-2.5 py-1.5 text-zinc-300 hover:bg-zinc-700/60"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>
      </div>

      {err && <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{err}</div>}

      {/* 汇总卡 */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
          <div className="text-2xl font-semibold tabular-nums text-emerald-300">{agg?.ready ?? '—'}</div>
          <div className="text-[11px] text-zinc-500">密钥待命（可立即生成）</div>
        </div>
        <div className="rounded-2xl border border-amber-500/20 bg-zinc-900/60 p-4">
          <div className="text-2xl font-semibold tabular-nums text-amber-300">{agg?.cooling ?? '—'}</div>
          <div className="text-[11px] text-zinc-500">密钥冷却中（429/熔断）</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
          <div className="text-2xl font-semibold tabular-nums text-zinc-300">{data?.modelsReady ?? '—'} / {data?.modelsTotal ?? '—'}</div>
          <div className="text-[11px] text-zinc-500">模型可生成</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
          <div className="text-2xl font-semibold tabular-nums text-amber-200">{data?.modelsCooling ?? '—'}</div>
          <div className="text-[11px] text-zinc-500">模型含冷却 key</div>
        </div>
      </div>

      {/* 密钥池总览 */}
      <section className="mb-5">
        <h2 className="mb-2 text-sm font-medium text-zinc-300">密钥池总览</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {data?.pools.map((p) => <PoolCard key={p.providerId} pool={p} />)}
          {data && data.pools.length === 0 && <div className="text-sm text-zinc-600">无密钥池</div>}
        </div>
      </section>

      {/* 模型状态表 */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-300">模型 → 密钥池 待命/冷却</h2>
        <div className="overflow-x-auto rounded-2xl border border-white/10 bg-zinc-900/60">
          <table className="w-full min-w-[720px] text-left">
            <thead>
              <tr className="border-b border-white/10 text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-2.5 font-medium">模型</th>
                <th className="px-3 py-2.5 font-medium">类型</th>
                <th className="px-3 py-2.5 font-medium">密钥池（就绪/冷却）</th>
                <th className="px-3 py-2.5 text-right font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {data?.models.map((m) => <ModelRow key={m.modelId} m={m} />)}
              {data && data.models.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-8 text-center text-sm text-zinc-600">暂无模型数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-zinc-600">冷却判定：key 429 冷却未到期 / 熔断 OPEN·HALF_OPEN / 管理端隔离 → 该 key 不参与派发；待命 = active 且未冷却。冷却 key 明细点击“刷新”前每 {REFRESH_MS / 1000}s 更新。</p>
      </section>
    </div>
  );
}
