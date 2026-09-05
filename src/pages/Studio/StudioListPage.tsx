// 创作工作室 · 项目列表（画布项目 / M05-C）
// 数据经 V2 project foundation（GET /api/v2/projects · POST /api/v2/projects）——
// 与画布路由 /studio/:projectId 同一张 projects 表，杜绝「列表能见、进入 404」。
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FolderPlus, Plus, LayoutGrid, Loader2,
  Sparkles, ChevronRight,
} from 'lucide-react';
import { PageHeader, SectionCard, Placeholder, cn } from '@/components/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { v2project } from '@/shared/api/contract/project-client';
import { toast } from 'sonner';

type ProjectType = 'general' | 'studio' | 'short_drama';

interface CanvasProjectRow {
  id: string;
  name: string;
  projectType: ProjectType;
  status: 'draft' | 'active' | 'archived';
  description: string;
}

const TYPE_META: Record<ProjectType, { icon: string; label: string }> = {
  general: { icon: '📁', label: '通用' },
  studio: { icon: '🎨', label: '创作' },
  short_drama: { icon: '🎬', label: '短剧' },
};

const STATUS_META: Record<CanvasProjectRow['status'], { label: string }> = {
  draft: { label: '草稿' },
  active: { label: '进行中' },
  archived: { label: '已归档' },
};

export default function StudioListPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<CanvasProjectRow[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ name: '', projectType: 'studio' as ProjectType, description: '' });
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [projRes, wsRes] = await Promise.all([
        v2project.listProjects(),
        v2project.listWorkspaces(),
      ]);
      setProjects(
        (projRes.projects ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          projectType: p.projectType,
          status: p.status,
          description: p.description ?? '',
        })),
      );
      setWorkspaceId(wsRes.workspaces?.[0]?.id ?? '');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载项目失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    const name = form.name.trim();
    if (!name) { toast.error('请输入项目名称'); return; }
    if (!workspaceId) { toast.error('无可用工作空间'); return; }
    setSubmitting(true);
    try {
      const d = await v2project.createProject({ workspaceId, name, description: form.description.trim(), projectType: form.projectType });
      toast.success('项目已创建');
      setProjects((prev) => [{
        id: d.project.id,
        name: d.project.name,
        projectType: d.project.projectType,
        status: d.project.status,
        description: d.project.description ?? '',
      }, ...prev]);
      setDialogOpen(false);
      setForm({ name: '', projectType: 'studio', description: '' });
      navigate(`/studio/${d.project.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="创作项目"
        subtitle="画布创作项目 · 分镜 → 视频 → 剧集"
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
                    <span>{TYPE_META[p.projectType]?.icon ?? '📁'}</span>
                    {TYPE_META[p.projectType]?.label ?? p.projectType}
                  </span>
                  <span className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                    p.status === 'active' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : p.status === 'archived' ? 'border-zinc-700 bg-zinc-800 text-zinc-400'
                      : 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
                  )}>
                    {STATUS_META[p.status]?.label ?? p.status}
                  </span>
                </div>
                <h3 className="mt-3 text-base font-semibold text-white group-hover:text-emerald-300 transition-colors line-clamp-1">
                  {p.name}
                </h3>
                {p.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{p.description}</p>
                )}
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-zinc-500">
                    画布项目 · {STATUS_META[p.status]?.label ?? p.status}
                  </span>
                  <span className="flex items-center gap-0.5 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 transition-colors group-hover:bg-emerald-500/10 group-hover:text-emerald-300">
                    进入 <ChevronRight className="size-3" />
                  </span>
                </div>
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
              还没有项目。点击「新建项目」创建一个画布项目。
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
          label="真实列表经 GET /api/v2/projects（与画布 /studio/:id 同表）"
          note="字段：name / projectType / status / description"
          height="h-20"
        />
      </SectionCard>

      {/* 新建项目弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg border-zinc-800 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-white">新建画布项目</DialogTitle>
            <DialogDescription className="text-zinc-500">
              创建后直接进入画布，可随时在各阶段迭代。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">项目名称</label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="例如：古风角色"
                className="border-zinc-700 bg-zinc-800/50 text-white placeholder:text-zinc-600 focus-visible:border-emerald-500/50"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">项目类型</label>
              <select
                value={form.projectType}
                onChange={(e) => setForm((f) => ({ ...f, projectType: e.target.value as ProjectType }))}
                className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-800/50 px-2 text-sm text-white outline-none focus:border-emerald-500/50"
              >
                {(Object.keys(TYPE_META) as ProjectType[]).map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
              </select>
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
              disabled={submitting || !form.name.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              创建
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
