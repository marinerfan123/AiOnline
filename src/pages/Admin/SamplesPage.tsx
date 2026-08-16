// 后台示例库管理（运营维护，一键推送给顾客）
// 数据源：default_assets 表（全局示例模板）。顾客通过 ensureUserDefaults 在注册/登录时
// 自动获得副本（is_default=TRUE）；本页提供 CRUD + 手动一键推送。
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Plus, Trash2, Pencil, Send, Library, Loader2, AlertTriangle,
} from 'lucide-react';
import {
  apiGetSamples, apiCreateSample, apiUpdateSample, apiDeleteSample, apiPushSamples,
} from '@/services/api';

const CATEGORIES = ['character', 'scene', 'prop', 'other', 'generated', 'upload'];
const TYPES = ['image', 'video'];
const RATIOS = ['1:1', '3:4', '4:5', '16:9', '9:16', '21:9'];
const STATUSES = ['success', 'pending', 'failed'];

const CATEGORY_LABELS: Record<string, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具参考',
  other: '其他',
  generated: '生成示例',
  upload: '上传示例',
};
const TYPE_LABELS: Record<string, string> = {
  image: '图片',
  video: '视频',
};
const RATIO_LABELS: Record<string, string> = {
  '1:1': '1:1（正方形）',
  '3:4': '3:4（竖屏）',
  '4:5': '4:5（竖屏）',
  '16:9': '16:9（横屏）',
  '9:16': '9:16（竖屏）',
  '21:9': '21:9（宽屏）',
};
const STATUS_LABELS: Record<string, string> = {
  success: '成功',
  pending: '生成中',
  failed: '失败',
};

const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');
const labelOf = (map: Record<string, string>, key?: string | null, fallback = '—') => (key && map[key]) ? `${key}（${map[key]}）` : fallback;

interface Sample {
  id: string;
  key: string;
  title: string;
  type: string;
  thumbnail: string;
  full_url: string;
  prompt: string;
  model: string;
  ratio: string;
  category: string;
  status: string;
  sort: number;
  created_at?: string;
}

export default function SamplesPage() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);

  // 编辑弹窗
  const [editing, setEditing] = useState<Sample | null>(null); // null=关闭, {}空对象=新增
  const [form, setForm] = useState<Partial<Sample>>({});
  const [saving, setSaving] = useState(false);

  // 删除确认
  const [deleting, setDeleting] = useState<Sample | null>(null);
  // 推送确认
  const [confirmPush, setConfirmPush] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGetSamples();
      setSamples(Array.isArray(list) ? list : []);
    } catch (e: any) {
      toast.error('加载示例库失败：' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm({ type: 'image', category: 'character', ratio: '1:1', status: 'success', sort: samples.length + 1, model: 'GM-IMG' });
    setEditing({} as Sample);
  };
  const openEdit = (s: Sample) => {
    setForm({ ...s });
    setEditing(s);
  };
  const closeModal = () => { setEditing(null); setForm({}); };

  const save = async () => {
    if (!form.title?.trim()) { toast.error('请填写标题'); return; }
    setSaving(true);
    try {
      if (editing && editing.id) {
        await apiUpdateSample(editing.id, form);
        toast.success('已保存修改');
      } else {
        await apiCreateSample(form);
        toast.success('已新增示例');
      }
      closeModal();
      await load();
    } catch (e: any) {
      toast.error('保存失败：' + (e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await apiDeleteSample(deleting.id);
      toast.success('已删除示例');
      setDeleting(null);
      await load();
    } catch (e: any) {
      toast.error('删除失败：' + (e?.message || e));
    }
  };

  const doPush = async () => {
    setPushing(true);
    try {
      const r: any = await apiPushSamples();
      toast.success(
        r?.note
          ? `推送完成：${r.note}`
          : `已推送给 ${r?.users ?? 0} 个顾客（新增 ${r?.pushed ?? 0} 条）`,
      );
      setConfirmPush(false);
    } catch (e: any) {
      toast.error('推送失败：' + (e?.message || e));
    } finally {
      setPushing(false);
    }
  };

  const set = (k: keyof Sample, v: any) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="p-6">
      {/* 头部 */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-white">
            <Library className="size-5 text-emerald-400" /> 示例库
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            维护一批示例素材，推送给新注册 / 现有顾客（顾客端标记为「示例」，可自行删除）。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={openCreate}
            className="flex items-center gap-2 rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 transition-colors"
          >
            <Plus className="size-4" /> 新增示例
          </button>
          <button
            onClick={() => setConfirmPush(true)}
            disabled={samples.length === 0}
            className="flex items-center gap-2 rounded-2xl bg-zinc-800 px-4 py-2 text-sm font-medium text-white ring-1 ring-zinc-700 hover:bg-zinc-700 disabled:opacity-40 transition-colors"
          >
            <Send className="size-4 text-emerald-400" /> 一键推送给顾客
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-3">预览</th>
              <th className="px-4 py-3">标题 / Key</th>
              <th className="px-4 py-3">分类</th>
              <th className="px-4 py-3">类型</th>
              <th className="px-4 py-3">比例</th>
              <th className="px-4 py-3">模型</th>
              <th className="px-4 py-3">排序</th>
              <th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-zinc-500">
                <Loader2 className="mx-auto size-5 animate-spin" />
              </td></tr>
            ) : samples.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-zinc-500">示例库为空，点「新增示例」开始添加</td></tr>
            ) : samples.map((s) => (
              <tr key={s.id} className="border-b border-zinc-900 last:border-0 hover:bg-zinc-900/40">
                <td className="px-4 py-3">
                  {s.thumbnail ? (
                    <img src={s.thumbnail} alt={s.title} className="size-10 rounded-lg object-cover ring-1 ring-zinc-800" />
                  ) : (
                    <div className="flex size-10 items-center justify-center rounded-lg bg-zinc-800 text-zinc-600">—</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-white">{s.title || '（无标题）'}</div>
                  <div className="text-[11px] text-zinc-500">{s.key}</div>
                </td>
                <td className="px-4 py-3 text-zinc-300">{labelOf(CATEGORY_LABELS, s.category)}</td>
                <td className="px-4 py-3 text-zinc-300">{labelOf(TYPE_LABELS, s.type)}</td>
                <td className="px-4 py-3 text-zinc-300">{RATIO_LABELS[s.ratio] || s.ratio}</td>
                <td className="px-4 py-3 text-zinc-300">{s.model || '—'}</td>
                <td className="px-4 py-3 text-zinc-300">{s.sort}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <button onClick={() => openEdit(s)} title="编辑"
                      className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors">
                      <Pencil className="size-4" />
                    </button>
                    <button onClick={() => setDeleting(s)} title="删除"
                      className="rounded-lg p-2 text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-colors">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 编辑 / 新增弹窗 */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closeModal}>
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-lg font-semibold text-white">
              {editing.id ? '编辑示例' : '新增示例'}
            </h2>
            <div className="space-y-3">
              <Field label="标题">
                <input className={inputCls} value={form.title || ''} onChange={(e) => set('title', e.target.value)} placeholder="示例·古风角色" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="分类">
                  <select className={inputCls} value={form.category || 'character'} onChange={(e) => set('category', e.target.value)}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}（{CATEGORY_LABELS[c]}）</option>)}
                  </select>
                </Field>
                <Field label="类型">
                  <select className={inputCls} value={form.type || 'image'} onChange={(e) => set('type', e.target.value)}>
                    {TYPES.map((t) => <option key={t} value={t}>{t}（{TYPE_LABELS[t]}）</option>)}
                  </select>
                </Field>
                <Field label="比例">
                  <select className={inputCls} value={form.ratio || '1:1'} onChange={(e) => set('ratio', e.target.value)}>
                    {RATIOS.map((r) => <option key={r} value={r}>{RATIO_LABELS[r] || r}</option>)}
                  </select>
                </Field>
                <Field label="排序">
                  <input type="number" className={inputCls} value={form.sort ?? 0} onChange={(e) => set('sort', Number(e.target.value))} />
                </Field>
              </div>
              <Field label="模型">
                <input className={inputCls} value={form.model || ''} onChange={(e) => set('model', e.target.value)} placeholder="Nano Banana Pro" />
              </Field>
              <Field label="缩略图 URL">
                <input className={inputCls} value={form.thumbnail || ''} onChange={(e) => set('thumbnail', e.target.value)} placeholder="/samples/character.svg 或 https://..." />
              </Field>
              <Field label="提示词">
                <textarea className={cn(inputCls, 'h-20 resize-none')} value={form.prompt || ''} onChange={(e) => set('prompt', e.target.value)} />
              </Field>
              <Field label="状态">
                  <select className={inputCls} value={form.status || 'success'} onChange={(e) => set('status', e.target.value)}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}（{STATUS_LABELS[s]}）</option>)}
                  </select>
              </Field>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={closeModal} className="rounded-2xl px-4 py-2 text-sm text-zinc-400 hover:text-white">取消</button>
              <button onClick={save} disabled={saving}
                className="flex items-center gap-2 rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50">
                {saving && <Loader2 className="size-4 animate-spin" />} 保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDeleting(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2 text-red-400">
              <AlertTriangle className="size-5" /> 确认删除
            </div>
            <p className="text-sm text-zinc-300">
              确定删除示例「{deleting.title || deleting.key}」？已推送给顾客的副本不会自动撤回（顾客可自行删除）。
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setDeleting(null)} className="rounded-2xl px-4 py-2 text-sm text-zinc-400 hover:text-white">取消</button>
              <button onClick={doDelete} className="rounded-2xl bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400">删除</button>
            </div>
          </div>
        </div>
      )}

      {/* 推送确认 */}
      {confirmPush && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setConfirmPush(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2 text-emerald-400">
              <Send className="size-5" /> 推送给顾客
            </div>
            <p className="text-sm text-zinc-300">
              将把当前 <span className="font-semibold text-white">{samples.length}</span> 条示例，批量拷贝给所有非管理员用户（已拥有的不会重复）。顾客端会标记为「示例」。
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setConfirmPush(false)} className="rounded-2xl px-4 py-2 text-sm text-zinc-400 hover:text-white">取消</button>
              <button onClick={doPush} disabled={pushing}
                className="flex items-center gap-2 rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50">
                {pushing && <Loader2 className="size-4 animate-spin" />} 确认推送
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls = 'w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-500">{label}</span>
      {children}
    </label>
  );
}
