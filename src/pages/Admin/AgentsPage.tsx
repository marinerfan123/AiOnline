// M4 全局智能体层（真实数据）
// 监控看板 + 管理：agents / agent_providers / agent_rules（§B.9）
// 接口：/api/admin/agents* / agent-providers / agent-rules*；调度器 dispatcher 令牌桶 + round-robin。
import { Bot, Server, GitBranch, BarChart3, Power, Wand2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, SectionCard, TabBar, StatCard, cn } from '@/components/skeleton';
import { useCallback, useEffect, useState } from 'react';
import {
  apiAdminAgents, apiAdminToggleAgent, apiAdminUpsertAgent,
  apiAdminAgentProviders, apiAdminAgentRules, apiAdminToggleAgentRule,
  apiGetModels, apiGetSettings, apiSaveSettings, apiAdminListSkills,
  type AdminAgent, type AgentProvider, type AgentRule, type ISkill,
} from '@/services/api';

export default function AgentsPage() {
  const [tab, setTab] = useState<'dashboard' | 'agents' | 'providers' | 'rules'>('dashboard');
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [rules, setRules] = useState<AgentRule[]>([]);
  const [skills, setSkills] = useState<ISkill[]>([]);
  const [loading, setLoading] = useState(true);
  // 新建智能体表单状态
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ key: '', name: '', agentType: 'model' as 'model' | 'skill', skillKey: '', dailyBudget: 0, enabled: true });
  const [savingAgent, setSavingAgent] = useState(false);
  // 提示词优化智能体：可选 text 模型（写入 settings.app.promptOptimizeModel）
  const [textModels, setTextModels] = useState<{ id: string; displayName: string; modelId: string }[]>([]);
  const [promptOptimizeModel, setPromptOptimizeModel] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  // 全局兜底模型（写入 settings.app.fallbackModel）：所有文本智能体在没有显式/专属模型时的统一回退
  const [fallbackModel, setFallbackModel] = useState('');
  const [savingFallback, setSavingFallback] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [a, p, r, ms, s, sk] = await Promise.all([
      apiAdminAgents(), apiAdminAgentProviders(), apiAdminAgentRules(),
      apiGetModels(), apiGetSettings(), apiAdminListSkills(),
    ]);
    setAgents(a); setProviders(p); setRules(r); setSkills(sk);
    setTextModels(ms.filter((m) => m.type === 'text' && m.enabled).map((m) => ({ id: m.id, displayName: m.displayName || '', modelId: m.modelId || '' })));
    if (s && s.promptOptimizeModel) setPromptOptimizeModel(String(s.promptOptimizeModel));
    if (s && s.fallbackModel) setFallbackModel(String(s.fallbackModel));
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const createAgent = async () => {
    if (!form.key || !form.name) return;
    setSavingAgent(true);
    const r = await apiAdminUpsertAgent({
      key: form.key, name: form.name, agentType: form.agentType,
      skillKey: form.agentType === 'skill' ? form.skillKey : '',
      dailyBudget: Number(form.dailyBudget) || 0, enabled: form.enabled,
    });
    setSavingAgent(false);
    if (r.ok) { setCreating(false); setForm({ key: '', name: '', agentType: 'model', skillKey: '', dailyBudget: 0, enabled: true }); await load(); }
    else alert(r.error || '创建失败');
  };

  const savePromptOptimizeModel = async () => {
    setSavingModel(true);
    try {
      const cur = (await apiGetSettings().catch(() => ({}))) || {};
      await apiSaveSettings({ ...cur, promptOptimizeModel });
      toast.success(promptOptimizeModel ? '已指定提示词优化模型' : '已恢复自动选择');
    } catch (e) {
      toast.error('保存失败');
    } finally {
      setSavingModel(false);
    }
  };

  const saveFallbackModel = async () => {
    setSavingFallback(true);
    try {
      const cur = (await apiGetSettings().catch(() => ({}))) || {};
      await apiSaveSettings({ ...cur, fallbackModel });
      toast.success(fallbackModel ? '已设置全局兜底模型' : '已清除兜底模型（回退到最便宜 text 模型）');
    } catch {
      toast.error('保存失败');
    } finally {
      setSavingFallback(false);
    }
  };

  const toggleAgent = async (a: AdminAgent) => {
    await apiAdminToggleAgent(a.key, !a.enabled);
    setAgents((prev) => prev.map((x) => (x.key === a.key ? { ...x, enabled: !x.enabled } : x)));
  };
  const toggleRule = async (r: AgentRule) => {
    await apiAdminToggleAgentRule(r.id, !r.enabled);
    setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)));
  };

  const enabledAgents = agents.filter((a) => a.enabled).length;
  const enabledRules = rules.filter((r) => r.enabled).length;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="全局智能体层"
        subtitle="M4 · 把 AI 能力建模为一等公民：看板 + 管理 + 自动化运营智能体"
        phase={{ status: 'ready', label: 'Phase 2 · 真实数据' }}
        icon={<Bot className="size-5" />}
      />

      <TabBar
        tabs={[
          { key: 'dashboard', label: '监控看板', icon: <BarChart3 className="size-4" /> },
          { key: 'agents', label: '智能体', icon: <Bot className="size-4" /> },
          { key: 'providers', label: '供应商', icon: <Server className="size-4" /> },
          { key: 'rules', label: '自动化规则', icon: <GitBranch className="size-4" /> },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'dashboard' && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="智能体总数" value={String(agents.length)} icon={<Bot className="size-4" />} />
          <StatCard label="启用中" value={String(enabledAgents)} icon={<Power className="size-4" />} />
          <StatCard label="自动化规则" value={String(rules.length)} icon={<GitBranch className="size-4" />} />
          <StatCard label="供应商映射" value={String(providers.length)} icon={<Server className="size-4" />} />
        </div>
      )}

      {tab === 'agents' && (
        <SectionCard
          title="agents 表"
          hint="key / name / agent_type / skill_key / enabled / daily_budget"
          actions={
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">{loading ? '加载中…' : `${enabledAgents}/${agents.length} 启用`}</span>
              <button
                onClick={() => setCreating((v) => !v)}
                className="rounded-xl bg-emerald-500/15 px-2.5 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25"
              >
                {creating ? '收起' : '新建智能体'}
              </button>
            </div>
          }
        >
          {creating && (
            <div className="mb-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-400">key（唯一）</span>
                  <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="my_skill_agent" className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-400">名称 name</span>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-400">类型 agent_type</span>
                  <select value={form.agentType} onChange={(e) => setForm({ ...form, agentType: e.target.value as 'model' | 'skill' })} className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500">
                    <option value="model">模型智能体（model）</option>
                    <option value="skill">技能智能体（skill）</option>
                  </select>
                </label>
                {form.agentType === 'skill' && (
                  <label className="block">
                    <span className="mb-1 block text-xs text-zinc-400">绑定技能 skill_key</span>
                    <select value={form.skillKey} onChange={(e) => setForm({ ...form, skillKey: e.target.value })} className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500">
                      <option value="">— 选择技能 —</option>
                      {skills.map((s) => <option key={s.key} value={s.key}>{s.name} ({s.key})</option>)}
                    </select>
                  </label>
                )}
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-400">日预算 daily_budget</span>
                  <input type="number" min={0} value={form.dailyBudget} onChange={(e) => setForm({ ...form, dailyBudget: Number(e.target.value) })} className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500" />
                </label>
              </div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button onClick={() => setCreating(false)} className="rounded-xl px-3 py-2 text-sm text-zinc-400 hover:text-white">取消</button>
                <button onClick={createAgent} disabled={savingAgent || !form.key || !form.name} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50">
                  {savingAgent ? '创建中…' : '创建智能体'}
                </button>
              </div>
            </div>
          )}
          <div className="space-y-2">
            {agents.map((a) => {
              const isPromptOptimizer = a.key === 'prompt_optimizer';
              const skillName = (a.config?.skillName as string) || '';
              const isSkillAgent = a.agentType === 'skill';
              return (
                <div key={a.key} className={cn('rounded-2xl px-4 py-3', isPromptOptimizer ? 'border border-emerald-500/20 bg-emerald-500/5' : 'bg-white/5')}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="font-medium text-zinc-100">{a.name}</div>
                        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', isSkillAgent ? 'bg-sky-500/15 text-sky-300' : 'bg-zinc-700/50 text-zinc-300')}>
                          {isSkillAgent ? '技能' : '模型'}
                        </span>
                        {skillName && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">{skillName}</span>}
                        {isSkillAgent && a.skillKey && <span className="rounded-full bg-zinc-800/60 px-2 py-0.5 text-[10px] text-zinc-400">↳ {a.skillKey}</span>}
                      </div>
                      <div className="text-xs text-zinc-500">{a.key} · 日预算 {a.dailyBudget}</div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {isPromptOptimizer && (
                        <div className="hidden sm:flex items-center gap-2">
                          <select
                            value={promptOptimizeModel}
                            onChange={(e) => setPromptOptimizeModel(e.target.value)}
                            className="min-w-[12rem] rounded-xl bg-zinc-900/50 px-3 py-1.5 text-xs text-zinc-200 border border-zinc-700/50 focus:outline-none focus:border-emerald-500/50"
                          >
                            <option value="">自动（最便宜的 text 模型）</option>
                            {textModels.map((m) => (
                              <option key={m.id} value={m.id}>{m.displayName || m.modelId}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => savePromptOptimizeModel()}
                            disabled={savingModel}
                            className="inline-flex items-center gap-1 rounded-xl bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
                          >
                            {savingModel ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                            保存
                          </button>
                        </div>
                      )}
                      <button
                        onClick={() => toggleAgent(a)}
                        className={cn('inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors',
                          a.enabled ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25' : 'bg-white/10 text-zinc-400 hover:bg-white/15')}
                      >
                        <Power className="size-3.5" /> {a.enabled ? '已启用' : '已停用'}
                      </button>
                    </div>
                  </div>
                  {isPromptOptimizer && (
                    <div className="mt-3 flex flex-col gap-2 sm:hidden">
                      <select
                        value={promptOptimizeModel}
                        onChange={(e) => setPromptOptimizeModel(e.target.value)}
                        className="w-full rounded-xl bg-zinc-900/50 px-3 py-2 text-xs text-zinc-200 border border-zinc-700/50 focus:outline-none focus:border-emerald-500/50"
                      >
                        <option value="">自动（最便宜的 text 模型）</option>
                        {textModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.displayName || m.modelId}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => savePromptOptimizeModel()}
                        disabled={savingModel}
                        className="inline-flex w-full items-center justify-center gap-1 rounded-xl bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
                      >
                        {savingModel ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                        保存模型设置
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {agents.length === 0 && !loading && <div className="py-6 text-center text-xs text-zinc-500">暂无智能体</div>}
          </div>
        </SectionCard>
      )}

      {tab === 'agents' && (
        <SectionCard
          title="全局文本推理模型"
          hint="兜底模型：当某智能体没有显式指定模型、也没有专属 agent_providers 时，统一回退到该模型"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <label className="block sm:max-w-sm">
              <span className="mb-1.5 block text-xs text-zinc-400">全局兜底模型（fallbackModel）</span>
              <select
                value={fallbackModel}
                onChange={(e) => setFallbackModel(e.target.value)}
                className="w-full rounded-xl bg-zinc-900/50 px-3 py-2 text-sm text-zinc-200 border border-zinc-700/50 focus:outline-none focus:border-emerald-500/50"
              >
                <option value="">关闭兜底（无模型时直接报错）</option>
                {textModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName || m.modelId}</option>
                ))}
              </select>
            </label>
            <button
              onClick={() => saveFallbackModel()}
              disabled={savingFallback}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {savingFallback ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
              保存兜底模型
            </button>
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            优先级：① 智能体显式模型（如提示词优化 / 翻译） ② 智能体专属 agent_providers ③ <span className="text-emerald-300">全局兜底模型</span> ④ 最便宜的启用 text 模型。
          </p>
        </SectionCard>
      )}

      {tab === 'providers' && (
        <SectionCard title="agent_providers 表" hint="agent_key / provider / model / weight / priority / cost_per_call / enabled">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-2 pr-4 font-medium">智能体</th>
                  <th className="py-2 pr-4 font-medium">供应商</th>
                  <th className="py-2 pr-4 font-medium">模型</th>
                  <th className="py-2 pr-4 font-medium">权重</th>
                  <th className="py-2 pr-4 font-medium">优先级</th>
                  <th className="py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {providers.map((p) => (
                  <tr key={p.id} className="text-zinc-200">
                    <td className="py-2.5 pr-4 text-zinc-300">{p.agentKey}</td>
                    <td className="py-2.5 pr-4">{p.provider || '—'}</td>
                    <td className="py-2.5 pr-4">{p.model || '—'}</td>
                    <td className="py-2.5 pr-4">{p.weight}</td>
                    <td className="py-2.5 pr-4">{p.priority}</td>
                    <td className="py-2.5"><span className={cn('rounded-full px-2 py-0.5 text-xs', p.enabled ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/10 text-zinc-400')}>{p.enabled ? '启用' : '停用'}</span></td>
                  </tr>
                ))}
                {providers.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-xs text-zinc-500">暂无供应商映射</td></tr>}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {tab === 'rules' && (
        <SectionCard title="agent_rules 表" hint="name / trigger / condition / action / enabled" actions={<span className="text-xs text-zinc-500">{loading ? '加载中…' : `${enabledRules}/${rules.length} 启用`}</span>}>
          <div className="space-y-2">
            {rules.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3">
                <div>
                  <div className="font-medium text-zinc-100">{r.name}</div>
                  <div className="text-xs text-zinc-500">trigger: {r.trigger} · {JSON.stringify(r.condition)}</div>
                </div>
                <button
                  onClick={() => toggleRule(r)}
                  className={cn('inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors',
                    r.enabled ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25' : 'bg-white/10 text-zinc-400 hover:bg-white/15')}
                >
                  <Power className="size-3.5" /> {r.enabled ? '已启用' : '已停用'}
                </button>
              </div>
            ))}
            {rules.length === 0 && !loading && <div className="py-6 text-center text-xs text-zinc-500">暂无规则</div>}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
