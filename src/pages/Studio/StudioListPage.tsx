// 创作工作室 · 项目列表（真实后端版，M5 / Phase 4）
// 数据经 GET /api/studio/projects；创建 / 更新 / 删除走对应 REST 接口。
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FolderPlus, Plus, LayoutGrid, Loader2, Trash2, AlertCircle,
  Sparkles, ChevronRight, type LucideIcon,
} from 'lucide-react';
import { PageHeader, SectionCard, Placeholder, PhaseBadge, cn } from '@/components/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  apiGetStudioProjects,
  apiCreateStudioProject,
  apiDeleteStudioProject,
} from '@/services/api';
import {
  type IStudioProject,
  STAGE_LABEL,
  TYPE_LABEL,
  STATUS_LABEL,
} from '@/data/studio';
import { toast } from 'sonner';

const TYPE_OPTIONS: Array<{ key: IStudioProject['type']; label: string; icon: string }> = [
  { key: 'story', label: '故事型', icon: '📖' },
  { key: 'commerce', label: '电商型', icon: '🛒' },
  { key: 'custom', label: '自定义', icon: '🎨' },
];

const STAGE_OPTIONS: Array<{ key: IStudioProject['currentStage']; label: string }> = [
  { key: 'idea', label: '点子孵化' },
  { key: 'script', label: '剧本' },
  { key: 'storyboard', label: '分镜' },
  { key: 'video', label: '视频' },
  { key: 'episode', label: '剧集' },
];

const STATUS_OPTIONS: Array<{ key: IStudioProject['status']; label: string }> = [
  { key: 'planning', label: '规划中' },
  { key: 'building', label: '开发中' },
  { key: 'ready', label: '已具备生成能力' },
  { key: 'live', label: '已上线' },
];

export default function StudioListPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<IStudioProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({
    title: '',
    type: 'story' as IStudioProject['type'],
    status: 'planning' as IStudioProject['status'],
    currentStage: 'idea' as IStudioProject['currentStage'],
    description: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IStudioProject | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setLoading(true);
    const list = await apiGetStudioProjects();
    setProjects(list);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async () => {
    const title = form.title.trim();
    if (!title) {
      toast.error('请输入项目名称');
      return;
    }
    setSubmitting(true);
    const r = await apiCreateStudioProject({
      title,
      type: form.type,
      status: form.status,
      currentStage: form.currentStage,
      description: form.description.trim(),
    });
    setSubmitting(false);
    if (r.ok && r.project) {
      toast.success('项目已创建');
      setProjects((prev) => [r.project!, ...prev]);
      setDialogOpen(false);
      setForm({ title: '', type: 'story', status: 'planning', currentStage: 'idea', description: '' });
    } else {
      toast.error(r.error || '创建失败');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const r = await apiDeleteStudioProject(deleteTarget.id);
    setDeleting(false);
    if (r.ok) {
      toast.success('项目已删除');
      setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      setDeleteTarget(null);
    } else {
      toast.error('删除失败');
    }
  };

  const typeIcon = (type: IStudioProject['type']) => TYPE_OPTIONS.find((t) => t.key === type)?.icon || '📁';

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="创作项目"
        subtitle="M5 创意生产流水线 · 点子 → 剧本 → 分镜 → 视频 → 剧集"
        phase={{ status: 'building', label: 'Phase 4' }}
        icon={<LayoutGrid className="size-5" />}
        actions={
          <button
            onClick={() => setDialogOpen(true)}
            className="flex items-center gap-1.5 rounded-2xl bg-emerald-500 px-3 py-2 text-sm font-medium text-black hover:bg-emerald-400 transition-colors"
          >
            <Plus className="size-4" /> 新建项目
          </button>
        }
      />

      {loading ? (
        <div className="flex min-h-[16rem] flex-col items-center justify-center gap-3 rounded-3xl border border-zinc-800 bg-zinc-900/50 text-zinc-400">
          <Loader2 className="size-6 animate-spin text-emerald-400" />
          <p className="text-sm">加载项目中…</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <div
              key={p.id}
              className="group relative rounded-3xl border border-zinc-800 bg-zinc-900/50 p-5 transition-all duration-300 hover:border-emerald-500/40 hover:bg-zinc-900 hover:shadow-lg hover:shadow-emerald-500/5"
            >
              <button
                onClick={() => navigate(`/studio/${p.id}`)}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-xs text-zinc-500">
                    <span>{typeIcon(p.type)}</span>
                    {TYPE_LABEL[p.type]}
                  </span>
                  <PhaseBadge status={p.status} label={STATUS_LABEL[p.status]} />
                </div>
                <h3 className="mt-3 text-base font-semibold text-white group-hover:text-emerald-300 transition-colors line-clamp-1">
                  {p.title}
                </h3>
                {p.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{p.description}</p>
                )}
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-zinc-500">
                    当前阶段：<span className="text-zinc-300">{STAGE_LABEL[p.currentStage]}</span>
                  </span>
                  <span className="flex items-center gap-0.5 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 transition-colors group-hover:bg-emerald-500/10 group-hover:text-emerald-300">
                    进入 <ChevronRight className="size-3" />
                  </span>
                </div>
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); setDeleteTarget(p); }}
                className="absolute top-3 right-3 rounded-xl p-1.5 text-zinc-600 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                title="删除项目"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}

          {/* 新建卡片 */}
          <button
            onClick={() => setDialogOpen(true)}
            className={cn(
              'flex flex-col items-center justify-center gap-2 rounded-3xl border border-dashed border-zinc-700/80 bg-zinc-900/30 p-5 text-center',
              'hover:border-emerald-500/40 hover:bg-zinc-900/50 transition-colors',
            )}
          >
            <div className="flex size-10 items-center justify-center rounded-2xl bg-zinc-800/80 text-emerald-400">
              <FolderPlus className="size-5" />
            </div>
            <span className="text-sm font-medium text-zinc-300">新建项目</span>
          </button>
        </div>
      )}

      {!loading && projects.length === 0 && (
        <SectionCard title="开始你的第一个项目" className="opacity-90">
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
              <Sparkles className="size-6" />
            </div>
            <p className="text-sm text-zinc-400">
              还没有项目。点击「新建项目」创建一条 M5 流水线作品。
            </p>
            <button
              onClick={() => setDialogOpen(true)}
              className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 transition-colors"
            >
              新建项目
            </button>
          </div>
        </SectionCard>
      )}

      <SectionCard title="项目表结构" hint="projects" className="opacity-80">
        <Placeholder
          label="真实列表经 GET /api/studio/projects（按 owner_id + updated_at 排序）"
          note="字段：title / type / status / current_stage"
          height="h-20"
        />
      </SectionCard>

      {/* 新建项目弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg border-zinc-800 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-white">新建项目</DialogTitle>
            <DialogDescription className="text-zinc-500">
              创建后会自动进入 M5 创意流水线，可随时在各阶段迭代。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">项目名称</label>
              <Input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="例如：古风角色"
                className="border-zinc-700 bg-zinc-800/50 text-white placeholder:text-zinc-600 focus-visible:border-emerald-500/50"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-400">项目类型</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as IStudioProject['type'] }))}
                  className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-800/50 px-2 text-sm text-white outline-none focus:border-emerald-500/50"
                >
                  {TYPE_OPTIONS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-400">当前阶段</label>
                <select
                  value={form.currentStage}
                  onChange={(e) => setForm((f) => ({ ...f, currentStage: e.target.value as IStudioProject['currentStage'] }))}
                  className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-800/50 px-2 text-sm text-white outline-none focus:border-emerald-500/50"
                >
                  {STAGE_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">项目描述</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="简要描述创作目标…"
                rows={3}
                className="w-full rounded-md border border-zinc-700 bg-zinc-800/50 p-3 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-emerald-500/50 resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={() => setDialogOpen(false)}
              className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={submitting || !form.title.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              创建
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white">
              <AlertCircle className="size-5 text-red-400" />
              删除项目
            </DialogTitle>
            <DialogDescription className="text-zinc-500">
              确定删除「<span className="text-zinc-300">{deleteTarget?.title}</span>」吗？项目内数据将一并移除，不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setDeleteTarget(null)}
              className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="flex items-center gap-1.5 rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400 disabled:opacity-50 transition-colors"
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              删除
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
