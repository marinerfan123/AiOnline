// 多槽位 OSS 配置面板（v2 重构版）
//
// 重构点（2026-08-05）：
//   • 双栏布局：左 = 实时日志（订阅 /api/oss/logs/stream），右 = 配置操作。
//   • 实时日志改用 SSE + useOssLogStream hook，而非组件内本地 addLog。
//     旧 addLog 用于记录前端操作的本地日志已被替代——
//     真实的所有 /api/oss/* 业务事件由后端 ossLogger 推送，含脱敏。
//   • 删除原 "前端动作"日志区块（create/save/test/delete/activate）：
//     这些动作本身就会触发后端端点 → 自动落日志，不再双写。
//   • 日志面板特性：连接状态点、level 过滤、清空、自动追底（用户滚上去暂停）。
//
// 数据由 useOssConfig 暴露配置：enabled/active/configs/动作。
import { useEffect, useMemo, useRef, useState } from 'react';
import { HardDriveUpload, Server, Plus, Pencil, Trash2, Check, Loader2, Eye, EyeOff, Database, Tag, FolderOpen, Globe, Activity, Filter, Trash2 as TrashIcon, CircleDot, ArrowDown } from 'lucide-react';
import { useOssConfig } from '@/hooks/useOssConfig';
import { useOssLogStream, type IOssLogEntry, type OssLogLevel } from '@/hooks/useOssLogStream';
import { type IOssConfig, type OssProviderType, DEFAULT_OSS_SLOT } from '@/data/oss';

const PROVIDER_META: Record<OssProviderType, { label: string; color: string; ring: string; bg: string }> = {
  'aliyun-oss': { label: '阿里云 OSS', color: 'text-orange-300', ring: 'ring-orange-500/30', bg: 'bg-gradient-to-br from-orange-500/15 to-amber-500/10' },
  'tencent-cos': { label: '腾讯云 COS', color: 'text-sky-300',   ring: 'ring-sky-500/30',     bg: 'bg-gradient-to-br from-sky-500/15 to-cyan-500/10' },
};

const UNKNOWN_PROVIDER_META = { label: '未知存储', color: 'text-zinc-300', ring: 'ring-zinc-500/30', bg: 'bg-zinc-500/10' };

function getProviderMeta(providerType?: string | null) {
  return PROVIDER_META[providerType as OssProviderType] ?? UNKNOWN_PROVIDER_META;
}

function ProviderBadge({ providerType, className = '' }: { providerType?: string | null; className?: string }) {
  const meta = getProviderMeta(providerType);
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold ring-1 ${meta.bg} ${meta.color} ${meta.ring} ${className}`}>
      {meta.label}
    </span>
  );
}

const PROVIDER_PRESETS: Record<OssProviderType, { region: string; regionLabel: string; endpointExternal: string }> = {
  'aliyun-oss': { region: 'cn-shanghai', regionLabel: '华东2（上海）', endpointExternal: 'oss-cn-shanghai.aliyuncs.com' },
  'tencent-cos': { region: 'ap-shanghai', regionLabel: '上海', endpointExternal: 'cos.ap-shanghai.myqcloud.com' },
};

const LEVEL_META: Record<OssLogLevel, { label: string; text: string; bg: string; border: string; dot: string }> = {
  info:    { label: 'INFO',    text: 'text-blue-300',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20',  dot: 'bg-blue-400' },
  success: { label: 'OK',      text: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', dot: 'bg-emerald-400' },
  warn:    { label: 'WARN',    text: 'text-amber-300',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20', dot: 'bg-amber-400' },
  error:   { label: 'ERROR',   text: 'text-red-300',     bg: 'bg-red-500/10',     border: 'border-red-500/20',   dot: 'bg-red-400' },
};

function genId() {
  return `oss-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function OssConfigPanel() {
  const { enabled, active, configs, setEnabled, reload, createSlot, updateSlot, deleteSlot, activateSlot, testSlot, testConfig } = useOssConfig();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

  const editing = useMemo(() => configs.find(c => c.id === editingId) || null, [editingId, configs]);

  // 默认编辑项 = active 槽位
  useEffect(() => {
    if (editingId == null && active) setEditingId(active.id);
  }, [active?.id]);

  async function handleAdd(providerType: OssProviderType) {
    const preset = PROVIDER_PRESETS[providerType];
    const slot: Partial<IOssConfig> = {
      id: genId(),
      providerType,
      displayName: `新${PROVIDER_META[providerType].label}账号`,
      ...preset,
      bucket: '',
      appId: '',
      accessKeyId: '',
      accessKeySecret: '',
      pathPrefix: DEFAULT_OSS_SLOT.pathPrefix,
      customDomain: '',
      enabled: true,
    };
    const ok = await createSlot(slot);
    if (ok && ok.id) setEditingId(ok.id);
  }

  function handleEdit(id: string) {
    const slot = configs.find(c => c.id === id);
    if (!slot) return;
    setEditingId(id);
    setDraft({ ...slot });
  }

  async function handleSave() {
    if (!editingId) return;
    setSavingId(editingId);
    await updateSlot(editingId, draft);
    setSavingId(null);
  }

  async function handleDelete(id: string) {
    if (configs.length <= 1) return;
    if (!confirm('删除该 OSS 槽位？删除后无法恢复。')) return;
    const ok = await deleteSlot(id);
    if (ok && editingId === id) setEditingId(active?.id || configs[0]?.id || null);
  }

  async function handleActivate(id: string) {
    await activateSlot(id);
  }

  async function handleTest(id: string) {
    setTestingId(id);
    // 如果正在编辑该槽位，测试当前表单草稿（保存前即时校验）
    const r = await (editingId === id ? testConfig(draft) : testSlot(id));
    setTestingId(null);
    setTestResults((prev) => ({ ...prev, [id]: r }));
  }

  function updateDraft(key: string, value: any) {
    setDraft((p) => ({ ...p, [key]: value }));
  }

  return (
    <div className="flex flex-col gap-5 lg:flex-row">
      {/* ───── 左栏：实时日志 ───── */}
      <aside className="lg:w-[380px] xl:w-[420px] shrink-0 lg:sticky lg:top-4 self-start lg:max-h-[calc(100vh-2rem)]">
        <OssLogPanel />
      </aside>

      {/* ───── 右栏：配置操作 ───── */}
      <div className="flex-1 min-w-0 space-y-5">
        {/* 头部：标题 + 总开关 */}
        <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400">
              <Database className="size-5" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-bold text-white">对象存储（OSS）</h2>
              <p className="text-xs text-zinc-500">配置多个云存储账号，活跃账号用于所有上传</p>
            </div>
            <span className={`text-xs font-semibold ${enabled ? 'text-emerald-400' : 'text-zinc-500'}`}>{enabled ? '总开关：开' : '总开关：关'}</span>
            <button
              onClick={() => setEnabled(!enabled)}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-all ${enabled ? 'bg-emerald-500' : 'bg-zinc-700'}`}
              aria-label="OSS 总开关"
            >
              <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>

          {/* Active 槽位条 */}
          <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-500/30">Active</span>
              {active ? (
                <span className="text-sm font-semibold text-white truncate">{active.displayName || active.bucket}</span>
              ) : (
                <span className="text-sm text-zinc-400">尚未设置活跃账号，所有上传将失败</span>
              )}
              {active && <ProviderBadge providerType={active.providerType} className="shrink-0 ml-auto" />}
            </div>
            {active && (
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-zinc-400">
                <div className="flex items-center gap-1.5"><FolderOpen className="size-3 opacity-60" /><span className="font-mono truncate">{active.bucket}</span></div>
                <div className="flex items-center gap-1.5"><Globe className="size-3 opacity-60" /><span>{active.regionLabel || active.region}</span></div>
                {active.providerType === 'tencent-cos' && active.appId && (
                  <div className="flex items-center gap-1.5 col-span-2"><Tag className="size-3 opacity-60" />AppId: <span className="font-mono">{active.appId}</span></div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 槽位列表 */}
        <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider">所有账号 ({configs.length})</h3>
            <button onClick={() => reload()} className="text-[10px] text-zinc-500 hover:text-white transition-colors">↻ 刷新</button>
          </div>
          <div className="space-y-1.5">
            {configs.map((c) => {
              const isActive = c.id === active?.id;
              const testR = testResults[c.id];
              return (
                <div key={c.id} className={`group flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-all ${isActive ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700'}`}>
                  <ProviderBadge providerType={c.providerType} className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-white">{c.displayName || c.bucket || c.id}</span>
                      {!c.enabled && <span className="shrink-0 rounded-md bg-zinc-800 px-1.5 py-0.5 text-[9px] font-semibold text-zinc-500">已停用</span>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
                      {c.bucket && <span className="font-mono">{c.bucket}</span>}
                      {c.bucket && <span>·</span>}
                      <span>{c.regionLabel || c.region}</span>
                      {testR && <><span>·</span><span className={testR.success ? 'text-emerald-400' : 'text-red-400'}>{testR.success ? '✓ ' : '✗ '}{testR.message.slice(0, 30)}</span></>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleTest(c.id)}
                      disabled={testingId === c.id}
                      className="rounded-lg bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      {testingId === c.id ? <Loader2 className="size-3 animate-spin" /> : <span>测试</span>}
                    </button>
                    <button
                      onClick={() => handleEdit(c.id)}
                      className="rounded-lg bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors inline-flex items-center gap-1"
                    >
                      <Pencil className="size-3" />编辑
                    </button>
                    {!isActive && (
                      <button
                        onClick={() => handleActivate(c.id)}
                        className="rounded-lg bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-500/25 hover:text-emerald-200 transition-colors inline-flex items-center gap-1"
                      >
                        <Check className="size-3" />设为活跃
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(c.id)}
                      className="rounded-lg bg-red-500/10 px-2 py-1 text-[10px] text-red-300 hover:bg-red-500/20 hover:text-red-200 transition-colors inline-flex items-center gap-1"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 新增账号 */}
          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              onClick={() => handleAdd('aliyun-oss')}
              className="group flex items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/30 py-3 text-xs font-semibold text-orange-300 hover:border-orange-500/40 hover:bg-orange-500/5 transition-all"
            >
              <HardDriveUpload className="size-4" />
              新增阿里云 OSS
            </button>
            <button
              onClick={() => handleAdd('tencent-cos')}
              className="group flex items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/30 py-3 text-xs font-semibold text-sky-300 hover:border-sky-500/40 hover:bg-sky-500/5 transition-all"
            >
              <Server className="size-4" />
              新增腾讯云 COS
            </button>
          </div>
        </div>

        {/* 编辑表单 */}
        {editing && (
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
            <div className="flex items-center gap-2 pb-2 border-b border-zinc-800/80">
              <ProviderBadge providerType={editing.providerType} className="shrink-0" />
              <input
                value={draft.displayName || ''}
                onChange={(e) => updateDraft('displayName', e.target.value)}
                placeholder="账号别名，便于辨识"
                className="min-w-0 flex-1 rounded-xl bg-zinc-900/60 px-3 py-1.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50"
              />
              <button
                onClick={() => setShowSecret((p) => ({ ...p, [editingId!]: !p[editingId!] }))}
                className="shrink-0 rounded-lg bg-zinc-800 px-2 py-1 text-[10px] text-zinc-400 hover:text-white transition-colors"
                title={showSecret[editingId!] ? '隐藏 Secret' : '显示 Secret'}
              >
                {showSecret[editingId!] ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                <span className="ml-1">Secret</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FieldText label="Bucket" placeholder="my-bucket-name" value={draft.bucket || ''} onChange={(v) => updateDraft('bucket', v)} mono />
              <FieldText
                label={editing.providerType === 'tencent-cos' ? 'AppId' : '区域（可读名）'}
                placeholder={editing.providerType === 'tencent-cos' ? '1300000000' : '华东2（上海）'}
                value={editing.providerType === 'tencent-cos' ? (draft.appId || '') : (draft.regionLabel || '')}
                onChange={(v) => updateDraft(editing.providerType === 'tencent-cos' ? 'appId' : 'regionLabel', v)}
                mono={editing.providerType === 'tencent-cos'}
              />
              <FieldText label="Region" placeholder={editing.providerType === 'tencent-cos' ? 'ap-shanghai' : 'cn-shanghai'} value={draft.region || ''} onChange={(v) => updateDraft('region', v)} mono />
              <FieldText label="外网 Endpoint" placeholder={editing.providerType === 'tencent-cos' ? 'cos.ap-shanghai.myqcloud.com' : 'oss-cn-shanghai.aliyuncs.com'} value={draft.endpointExternal || ''} onChange={(v) => updateDraft('endpointExternal', v)} mono />
            </div>

            <div className="space-y-3">
              <FieldSecret label={editing.providerType === 'tencent-cos' ? 'SecretId' : 'AccessKey ID'} value={draft.accessKeyId || ''} onChange={(v) => updateDraft('accessKeyId', v)} visible={!!showSecret[editingId!]} />
              <FieldSecret label={editing.providerType === 'tencent-cos' ? 'SecretKey' : 'AccessKey Secret'} value={draft.accessKeySecret || ''} onChange={(v) => updateDraft('accessKeySecret', v)} visible={!!showSecret[editingId!]} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FieldText label="存储路径前缀" placeholder="images/" value={draft.pathPrefix || ''} onChange={(v) => updateDraft('pathPrefix', v)} mono />
              <FieldText label="自定义 CDN 域名" placeholder="cdn.example.com" value={draft.customDomain || ''} onChange={(v) => updateDraft('customDomain', v)} mono />
            </div>

            <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/80">
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.enabled !== false}
                  onChange={(e) => updateDraft('enabled', e.target.checked)}
                  className="size-3.5 rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/30"
                />
                启用此账号
              </label>
              <div className="flex-1" />
              <button
                onClick={() => handleTest(editing.id)}
                disabled={testingId === editing.id}
                className="rounded-xl bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {testingId === editing.id ? <Loader2 className="size-3 animate-spin" /> : <span>测试连接</span>}
              </button>
              <button
                onClick={handleSave}
                disabled={savingId === editing.id}
                className="rounded-xl bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {savingId === editing.id ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}保存
              </button>
            </div>
            {testResults[editing.id] && (
              <div className={`rounded-xl border px-3 py-2 text-xs ${testResults[editing.id].success ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300' : 'border-red-500/30 bg-red-500/5 text-red-300'}`}>
                {testResults[editing.id].message}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 实时日志子组件（独立折叠方便日后挪走） ───────────────────────
function OssLogPanel() {
  const { logs, totalLogs, connected, filter, setFilter, clear } = useOssLogStream();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoStick, setAutoStick] = useState(true);  // 是否自动追底

  // 自动追底：日志变化 & autoStick 时滚到底
  useEffect(() => {
    if (!autoStick) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, autoStick]);

  // 用户滚上去 → 关追底；用户滚到底 → 开追底
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    setAutoStick(stick);
  }

  const FILTERS: { v: OssLogFilter | 'all'; label: string; dot: string }[] = [
    { v: 'all',     label: '全部', dot: 'bg-zinc-400' },
    { v: 'success', label: '成功', dot: 'bg-emerald-400' },
    { v: 'info',    label: '信息', dot: 'bg-blue-400' },
    { v: 'warn',    label: '警告', dot: 'bg-amber-400' },
    { v: 'error',   label: '错误', dot: 'bg-red-400' },
  ];

  return (
    <div className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-3 flex flex-col h-[calc(100vh-2rem)] min-h-[480px]">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-300">
          <Activity className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-sm font-bold text-white">OSS 实时日志</h2>
            <span className={`inline-flex h-2 w-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.6)]' : 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)] animate-pulse'}`} title={connected ? '已连接' : '断线'} />
            <span className={`text-[10px] font-semibold ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
          <p className="text-[10px] text-zinc-500 truncate">监控 /api/oss/* 所有操作 · 最近 {totalLogs} 条</p>
        </div>
        <button
          onClick={clear}
          className="shrink-0 rounded-lg bg-zinc-800 px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors inline-flex items-center gap-1"
          title="清空本视图（不影响后端缓冲）"
        >
          <TrashIcon className="size-3" />
          清空
        </button>
      </div>

      {/* 过滤栏 */}
      <div className="flex items-center gap-1.5 px-2 py-2 border-b border-zinc-800 overflow-x-auto">
        <Filter className="size-3 text-zinc-500 shrink-0" />
        {FILTERS.map((f) => (
          <button
            key={f.v}
            onClick={() => setFilter(f.v as any)}
            className={`shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold transition-colors ${filter === f.v ? 'bg-zinc-700 text-white' : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${f.dot}`} />
            {f.label}
          </button>
        ))}
        {!autoStick && (
          <button
            onClick={() => { setAutoStick(true); setTimeout(() => { const el=scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, 0); }}
            className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-md bg-cyan-500/15 px-2 py-0.5 text-[10px] font-semibold text-cyan-300 hover:bg-cyan-500/25 transition-colors"
          >
            <ArrowDown className="size-3" />
            回到底部
          </button>
        )}
      </div>

      {/* 日志列表 */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto p-2 space-y-1 font-mono text-[11px]"
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <div className="text-xs text-zinc-600">
              <CircleDot className="mx-auto mb-2 size-6 opacity-40" />
              等待日志…<br />
              <span className="text-[10px] opacity-60">在右侧触发任意 OSS 操作即可看到</span>
            </div>
          </div>
        ) : (
          logs.map((log) => <LogRow key={log.id} log={log} />)
        )}
      </div>
    </div>
  );
}

function LogRow({ log }: { log: IOssLogEntry }) {
  const meta = LEVEL_META[log.level] || LEVEL_META.info;
  const time = fmtTime(log.ts);
  return (
    <div className={`rounded-md border ${meta.border} ${meta.bg} px-2 py-1 leading-snug`}>
      <div className="flex items-baseline gap-1.5">
        <span className="shrink-0 text-[9px] text-zinc-500 tabular-nums">{time}</span>
        <span className={`shrink-0 rounded px-1 text-[9px] font-bold ${meta.text} bg-black/30`}>{meta.label}</span>
        <span className="shrink-0 rounded px-1 text-[9px] font-semibold text-zinc-300 bg-black/20">{log.action}</span>
      </div>
      <div className="mt-0.5 text-zinc-200 break-all">{log.message}</div>
      {log.details && Object.keys(log.details).length > 0 && (
        <details className="mt-0.5">
          <summary className="cursor-pointer text-[9px] text-zinc-500 hover:text-zinc-300 select-none">details</summary>
          <pre className="mt-1 max-h-32 overflow-y-auto rounded bg-black/30 px-2 py-1 text-[10px] text-zinc-400 whitespace-pre-wrap break-all">
{JSON.stringify(log.details, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

// ── 小组件 ──────────────────────────────────────────────
function FieldText({ label, value, onChange, placeholder, mono = false }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-zinc-400">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-xl bg-zinc-800/50 px-3 py-2 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors ${mono ? 'font-mono text-xs' : ''}`}
      />
    </div>
  );
}
function FieldSecret({ label, value, onChange, visible }: { label: string; value: string; onChange: (v: string) => void; visible: boolean }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-zinc-400">{label}</label>
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="••••••"
        className="w-full rounded-xl bg-zinc-800/50 px-3 py-2 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors font-mono"
      />
    </div>
  );
}
