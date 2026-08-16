// 技能注册（M4/M6 · skill_registry）
// 后台运营维护「能力原子」：key / name / stage / adapter / params / cost_credits / enabled。
// 市集商品(skill_pack) 通过 ref_key 引用这里的能力；智能体层(agent_type=skill) 也绑定这里。
import { useEffect, useState } from 'react';
import { Boxes, Pencil, Plus, Trash2, Power, PowerOff, Check } from 'lucide-react';
import { PageHeader, SectionCard, Placeholder, cn } from '@/components/skeleton';
import {
  apiAdminListSkills,
  apiAdminSaveSkill,
  apiAdminDeleteSkill,
  type ISkill,
} from '@/services/api';
import { formatCredits } from '@/utils/format';

const STAGE_OPTIONS = [
  { value: 'generation', label: '生成 (generation)' },
  { value: 'prompt', label: '提示词 (prompt)' },
  { value: 'post', label: '后期 (post)' },
  { value: 'analysis', label: '分析 (analysis)' },
];

type FormState = {
  key: string;
  name: string;
  stage: string;
  adapter: string;
  costCredits: number;
  enabled: boolean;
  description: string;
  author: string;
  icon: string;
  version: string;
  paramsText: string;
};

const EMPTY_FORM: FormState = {
  key: '',
  name: '',
  stage: 'generation',
  adapter: 'text_gen',
  costCredits: 0,
  enabled: true,
  description: '',
  author: '官方',
  icon: 'sparkles',
  version: '1.0.0',
  paramsText: '{}',
};

export default function SkillsPage() {
  const [skills, setSkills] = useState<ISkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    setLoading(true);
    const data = await apiAdminListSkills();
    setSkills(data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  function openCreate() { setMsg(null); setEditing({ ...EMPTY_FORM }); }
  function openEdit(s: ISkill) {
    setMsg(null);
    setEditing({
      key: s.key,
      name: s.name,
      stage: s.stage,
      adapter: s.adapter,
      costCredits: s.costCredits,
      enabled: s.enabled,
      description: s.description,
      author: s.author,
      icon: s.icon,
      version: s.version,
      paramsText: s.params ? JSON.stringify(s.params, null, 2) : '{}',
    });
  }
  function closeEdit() { setEditing(null); }

  async function submit() {
    if (!editing) return;
    setSaving(true);
    setMsg(null);
    let params: Record<string, unknown> = {};
    const t = editing.paramsText.trim();
    if (t && t !== '{}') {
      try { params = JSON.parse(t); }
      catch { setSaving(false); setMsg({ ok: false, text: 'params 不是合法 JSON' }); return; }
    }
    const payload: Partial<ISkill> & { key: string; params?: Record<string, unknown> } = {
      key: editing.key,
      name: editing.name || editing.key,
      stage: editing.stage,
      adapter: editing.adapter,
      costCredits: Number(editing.costCredits) || 0,
      enabled: editing.enabled,
      description: editing.description,
      author: editing.author,
      icon: editing.icon,
      version: editing.version,
      params,
    };
    const r = await apiAdminSaveSkill(payload);
    setSaving(false);
    if (r.ok) { setMsg({ ok: true, text: '已保存' }); setEditing(null); await load(); }
    else setMsg({ ok: false, text: r.error || '保存失败' });
  }

  async function toggleEnabled(s: ISkill) {
    const r = await apiAdminSaveSkill({ key: s.key, enabled: !s.enabled });
    if (r.ok) await load();
    else setMsg({ ok: false, text: r.error || '更新失败' });
  }

  async function remove(s: ISkill) {
    if (!confirm(`确认删除技能「${s.name}」(key=${s.key})？关联商品的获取将失效。`)) return;
    const r = await apiAdminDeleteSkill(s.key);
    if (r.ok) await load();
    else setMsg({ ok: false, text: r.error || '删除失败' });
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="技能注册"
        subtitle="skill_registry · 可插拔能力原子（市集数字能力包 / 智能体层共享挂载）"
        phase={{ status: 'live', label: 'Phase 4 · 已上线' }}
        icon={<Boxes className="size-5" />}
        actions={
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 rounded-2xl bg-emerald-500 px-3 py-2 text-sm font-medium text-black hover:bg-emerald-400 transition-colors"
          >
            <Plus className="size-4" /> 注册技能
          </button>
        }
      />

      {msg && (
        <div className={cn('rounded-2xl border px-4 py-2.5 text-sm', msg.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300')}>
          {msg.text}
        </div>
      )}

      {/* 新建 / 编辑表单 */}
      {editing && (
        <SectionCard
          title={editing.key ? `编辑技能 · ${editing.key}` : '注册新技能'}
          hint="adapter 决定执行逻辑（prompt_optimize / text_gen / 自定义）"
          actions={<button onClick={closeEdit} className="text-sm text-zinc-400 hover:text-white">取消</button>}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="key（唯一标识，创建后不可改）">
              <input
                value={editing.key}
                disabled={!!editing.key && skills.some((s) => s.key === editing.key)}
                onChange={(e) => setEditing({ ...editing, key: e.target.value })}
                placeholder="prompt_optimize"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500 disabled:opacity-50"
              />
            </Field>
            <Field label="名称 name">
              <input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
              />
            </Field>
            <Field label="stage（阶段）">
              <select
                value={editing.stage}
                onChange={(e) => setEditing({ ...editing, stage: e.target.value })}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
              >
                {STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="adapter（执行器）">
              <input
                value={editing.adapter}
                onChange={(e) => setEditing({ ...editing, adapter: e.target.value })}
                placeholder="prompt_optimize / text_gen"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
              />
            </Field>
            <Field label="单次积分 cost_credits">
              <input
                type="number"
                min={0}
                value={editing.costCredits}
                onChange={(e) => setEditing({ ...editing, costCredits: Number(e.target.value) })}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
              />
            </Field>
            <Field label="图标 icon / 版本 version">
              <div className="flex gap-2">
                <input
                  value={editing.icon}
                  onChange={(e) => setEditing({ ...editing, icon: e.target.value })}
                  placeholder="sparkles"
                  className="w-1/2 rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
                />
                <input
                  value={editing.version}
                  onChange={(e) => setEditing({ ...editing, version: e.target.value })}
                  className="w-1/2 rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
                />
              </div>
            </Field>
            <Field label="作者 author">
              <input
                value={editing.author}
                onChange={(e) => setEditing({ ...editing, author: e.target.value })}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
              />
            </Field>
            <Field label="启用 enabled">
              <button
                onClick={() => setEditing({ ...editing, enabled: !editing.enabled })}
                className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-sm', editing.enabled ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 bg-zinc-900 text-zinc-400')}
              >
                {editing.enabled ? <Power className="size-4" /> : <PowerOff className="size-4" />}
                {editing.enabled ? '已启用' : '已停用'}
              </button>
            </Field>
            <div className="md:col-span-2">
              <Field label="描述 description">
                <textarea
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  rows={2}
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
                />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="params（JSON，例如 max_tokens / temperature）">
                <textarea
                  value={editing.paramsText}
                  onChange={(e) => setEditing({ ...editing, paramsText: e.target.value })}
                  rows={3}
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-white outline-none focus:border-emerald-500"
                />
              </Field>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={closeEdit} className="rounded-xl px-3 py-2 text-sm text-zinc-400 hover:text-white">取消</button>
            <button
              onClick={submit}
              disabled={saving || !editing.key}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
            >
              <Check className="size-4" /> {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </SectionCard>
      )}

      {/* 列表 */}
      <SectionCard title="skill_registry" hint="已注册能力原子">
        {loading ? (
          <Placeholder label="加载中…" height="h-32" />
        ) : skills.length === 0 ? (
          <Placeholder label="暂无技能，点击右上角「注册技能」创建第一个能力" height="h-32" />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {skills.map((s) => (
              <div key={s.key} className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{s.name}</span>
                      <span className={cn('rounded-full px-1.5 py-0.5 text-[10px]', s.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700/40 text-zinc-400')}>
                        {s.enabled ? '启用' : '停用'}
                      </span>
                    </div>
                    <code className="text-xs text-zinc-500">{s.key}</code>
                  </div>
                  <span className="rounded-lg bg-zinc-800/60 px-2 py-0.5 text-[11px] text-zinc-400">{s.adapter}</span>
                </div>
                <p className="mt-2 line-clamp-2 text-xs text-zinc-400">{s.description || '—'}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                  <span className="rounded-md bg-zinc-800/60 px-1.5 py-0.5">stage: {s.stage}</span>
                  <span className="rounded-md bg-zinc-800/60 px-1.5 py-0.5">花费: {formatCredits(s.costCredits)} 积分</span>
                  <span className="rounded-md bg-zinc-800/60 px-1.5 py-0.5">v{s.version}</span>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => toggleEnabled(s)} className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-300">
                    {s.enabled ? '停用' : '启用'}
                  </button>
                  <button onClick={() => openEdit(s)} className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-300">
                    <Pencil className="size-3" /> 编辑
                  </button>
                  <button onClick={() => remove(s)} className="flex items-center gap-1 rounded-lg border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10">
                    <Trash2 className="size-3" /> 删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-zinc-400">{label}</span>
      {children}
    </label>
  );
}
