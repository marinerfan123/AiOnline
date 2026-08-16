// 创作工作台 · 五阶段（真实项目版，M5 / Phase 4 / §F）
// 点子孵化 / 小说转剧本 / 无限画布分镜 / 视频生成 / 剧集编排
// 每个节点：校验积分 → 调 skill_registry adapter → Agent Layer 执行 → 写产物 → 落 credit_transactions。
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Lightbulb,
  ScrollText,
  LayoutGrid,
  Film,
  Clapperboard,
  Loader2,
  ChevronLeft,
} from 'lucide-react';
import { PageHeader, SectionCard, Placeholder, TabBar, PhaseBadge } from '@/components/skeleton';
import { apiGetStudioProject, apiUpdateStudioProject } from '@/services/api';
import { type IStudioProject, STAGE_LABEL, STATUS_LABEL, type StudioProjectStage } from '@/data/studio';
import { toast } from 'sonner';

const STAGES: Array<{ key: StudioProjectStage; label: string; icon: React.ReactNode; node: string; skill: string; cost: string; ready: boolean }> = [
  { key: 'idea', label: '点子孵化', icon: <Lightbulb className="size-4" />, node: '/api/nodes/idea', skill: 'brainstorm', cost: '1', ready: false },
  { key: 'script', label: '剧本', icon: <ScrollText className="size-4" />, node: '/api/nodes/script', skill: 'screenwriter', cost: '3', ready: false },
  { key: 'storyboard', label: '无限画布分镜', icon: <LayoutGrid className="size-4" />, node: '/api/nodes/storyboard', skill: 'comic_layout', cost: '1/张', ready: true },
  { key: 'video', label: '视频生成', icon: <Film className="size-4" />, node: '/api/nodes/video', skill: 'video_gen', cost: '10/片段', ready: true },
  { key: 'episode', label: '剧集编排', icon: <Clapperboard className="size-4" />, node: '/api/nodes/episode', skill: 'publish_agent', cost: '0（编排）', ready: false },
];

export default function StudioStagePage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<IStudioProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState<StudioProjectStage>('storyboard');
  const [savingStage, setSavingStage] = useState(false);

  useEffect(() => {
    if (!projectId || projectId === 'new') return;
    setLoading(true);
    apiGetStudioProject(projectId).then((p) => {
      if (p) {
        setProject(p);
        setStage(p.currentStage);
      }
      setLoading(false);
    });
  }, [projectId]);

  const handleStageChange = async (next: StudioProjectStage) => {
    setStage(next);
    if (!project || next === project.currentStage) return;
    setSavingStage(true);
    const r = await apiUpdateStudioProject(project.id, { currentStage: next });
    setSavingStage(false);
    if (r.ok && r.project) {
      setProject(r.project);
      toast.success(`当前阶段已保存为「${STAGE_LABEL[next]}」`);
    } else {
      toast.error('阶段保存失败');
    }
  };

  const current = STAGES.find((s) => s.key === stage)!;

  if (loading) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-center gap-3 p-20 text-zinc-400">
        <Loader2 className="size-6 animate-spin text-emerald-400" />
        <p className="text-sm">加载项目中…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      {/* 项目头 */}
      <PageHeader
        title={project ? project.title : `项目 #${projectId ?? 'new'}`}
        subtitle={project ? `M5 流水线 · 当前阶段：${STAGE_LABEL[project.currentStage]} · ${STATUS_LABEL[project.status]}` : 'M5 流水线 · 五阶段可回退迭代，每节点挂 skill / agent'}
        icon={<LayoutGrid className="size-5" />}
        actions={
          <button
            onClick={() => navigate('/studio')}
            className="flex items-center gap-1.5 rounded-2xl border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/50 transition-colors"
          >
            <ChevronLeft className="size-4" />
            项目列表
          </button>
        }
      />

      {/* 五阶段 Tab */}
      <TabBar
        tabs={STAGES.map((s) => ({ key: s.key, label: s.label, icon: s.icon }))}
        active={stage}
        onChange={handleStageChange}
      />

      {/* 当前阶段详情 */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-white">{current.label}</h2>
          <PhaseBadge status={current.ready ? 'ready' : 'planning'} />
          {savingStage && <Loader2 className="size-4 animate-spin text-emerald-400" />}
          <span className="text-xs text-zinc-500">
            节点 {current.node} · skill={current.skill} · 计费 {current.cost}
          </span>
        </div>

        {stage === 'idea' && (
          <SectionCard title="ideas 表" hint="content / expanded（智能体扩写）">
            <Placeholder label="头脑风暴画布：输入点子 → brainstorm 扩写世界观" note="POST /api/nodes/idea（计费 1）" height="h-56" />
          </SectionCard>
        )}

        {stage === 'script' && (
          <SectionCard title="scripts 表" hint="title / body（含场景标记）/ source_idea_id">
            <Placeholder label="AI 编剧：点子扩写成可拍摄剧本" note="POST /api/nodes/script（计费 3）" height="h-56" />
          </SectionCard>
        )}

        {stage === 'storyboard' && (
          <SectionCard title="canvas_nodes + storyboards" hint="node_type / x,y,w,h / data · panels[]" className="ring-1 ring-emerald-500/20">
            <Placeholder
              label="无限画布：编排分镜漫画，挂生成能力一键出图（核心引擎，已具备生成能力）"
              note="POST /api/nodes/storyboard（comic_layout，按张计费 1/张）；Konva/tldraw 预留"
              height="h-64"
            />
          </SectionCard>
        )}

        {stage === 'video' && (
          <SectionCard title="video_jobs 表" hint="status(pending|running|done|failed) / input_ref / output_url / credits_cost=10">
            <Placeholder label="分镜转动态视频：异步队列渲染（BullMQ）" note="POST /api/nodes/video（video_gen，10/片段）" height="h-56" />
          </SectionCard>
        )}

        {stage === 'episode' && (
          <SectionCard title="episodes 表" hint="seq / title / video_ids[] / status">
            <Placeholder label="多集统一编排与发布（publish_agent）" note="POST /api/nodes/episode（编排，0 计费）" height="h-56" />
          </SectionCard>
        )}
      </div>
    </div>
  );
}
