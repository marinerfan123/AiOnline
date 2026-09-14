// V2 Project Overview page (M01-S). Entry point for future Studio modules.

import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Clapperboard, Images, ListChecks, Archive, RotateCcw } from 'lucide-react';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';
import { ProjectShell } from '@/features/project-foundation/ProjectShell';
import { Button } from '@/shared/ui/v2/Button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/shared/ui/v2/Card';
import { StatusBadge } from '@/shared/ui/v2/StatusBadge';
import { v2project } from '@/shared/api/contract/project-client';
import { toast } from 'sonner';
import { DeliverySpecPanel } from '@/pages/ProjectsPage/DeliverySpecPanel';
import { BriefPanel } from '@/pages/ProjectsPage/BriefPanel';

function QuickAction({
  icon: Icon,
  label,
  description,
  onClick,
  disabled,
  comingSoon,
}: {
  icon: React.ElementType;
  label: string;
  description: string;
  onClick?: () => void;
  disabled?: boolean;
  comingSoon?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || comingSoon}
      className="flex flex-col items-start gap-2 rounded-lg border border-ml2-border bg-ml2-surface-1 p-4 text-left transition-colors hover:border-ml2-accent hover:bg-ml2-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="flex w-full items-center justify-between">
        <Icon className="size-5 text-ml2-accent" />
        {comingSoon && <span className="text-[10px] text-ml2-text-3">即将上线</span>}
      </div>
      <div>
        <p className="text-sm font-medium text-ml2-text">{label}</p>
        <p className="text-xs text-ml2-text-3">{description}</p>
      </div>
    </button>
  );
}

function OverviewContent() {
  const ctx = useProjectContext();
  const navigate = useNavigate();

  const archive = useMutation({
    mutationFn: () => v2project.archiveProject(ctx.projectId),
    onSuccess: () => {
      toast.success('项目已归档');
      ctx.reload();
    },
  });

  const restore = useMutation({
    mutationFn: () => v2project.restoreProject(ctx.projectId),
    onSuccess: () => {
      toast.success('项目已恢复');
      ctx.reload();
    },
  });

  const status = ctx.projectStatus === 'active' ? 'active' : ctx.projectStatus === 'archived' ? 'disabled' : 'queued';

  return (
    <div className="space-y-4" data-test="project-overview">
      {/* Identity card */}
      <Card>
        <CardHeader>
          <CardTitle>项目信息</CardTitle>
          <CardDescription>本项目的稳定身份和权限边界</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs text-ml2-text-3">名称</p>
            <p className="text-sm text-ml2-text">{ctx.projectName}</p>
          </div>
          <div>
            <p className="text-xs text-ml2-text-3">类型</p>
            <p className="text-sm capitalize text-ml2-text">{ctx.projectType}</p>
          </div>
          <div>
            <p className="text-xs text-ml2-text-3">状态</p>
            <StatusBadge status={status} label={ctx.projectStatus} />
          </div>
          <div>
            <p className="text-xs text-ml2-text-3">工作空间 ID</p>
            <p className="text-sm text-ml2-text">{ctx.workspaceId}</p>
          </div>
          <div>
            <p className="text-xs text-ml2-text-3">角色</p>
            <p className="text-sm capitalize text-ml2-text">{ctx.permissions.role}</p>
          </div>
          <div>
            <p className="text-xs text-ml2-text-3">项目 ID</p>
            <p className="text-sm text-ml2-text">{ctx.projectId}</p>
          </div>
        </CardContent>
      </Card>

      {/* DeliverySpec (W1-07): visible, editable, validated, exact echo */}
      <DeliverySpecPanel projectId={ctx.projectId} canUpdate={ctx.permissions.canUpdate} />

      {/* Creative Brief (W1-06): visible, editable, validated, exact echo */}
      <BriefPanel projectId={ctx.projectId} canUpdate={ctx.permissions.canUpdate} />

      {/* Quick actions */}
      <Card>
        <CardHeader>
          <CardTitle>快捷入口</CardTitle>
          <CardDescription>跳转到 Studio / 素材 / 任务等下游模块</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <QuickAction
              icon={Clapperboard}
              label="Open Studio"
              description="进入 Studio 画布入口"
              onClick={() => navigate(`/__v2/projects/${ctx.projectId}/studio`)}
            />
            <QuickAction
              icon={Images}
              label="Assets"
              description="管理项目素材"
              comingSoon
            />
            <QuickAction
              icon={ListChecks}
              label="Tasks"
              description="查看生成任务"
              comingSoon
            />
          </div>
        </CardContent>
      </Card>

      {/* Recent activity placeholder contract */}
      <Card>
        <CardHeader>
          <CardTitle>最近活动</CardTitle>
          <CardDescription>项目内的近期动态将在后续模块中展示</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-dashed border-ml2-border bg-ml2-surface-0 p-6 text-center text-xs text-ml2-text-3">
            Coming in Studio Fast Track
          </div>
        </CardContent>
      </Card>

      {/* Lifecycle actions */}
      <div className="flex justify-end gap-2">
        {ctx.projectStatus === 'archived' ? (
          <Button
            variant="secondary"
            size="md"
            loading={restore.isPending}
            disabled={!ctx.permissions.canRestore}
            onClick={() => restore.mutate()}
          >
            <RotateCcw className="size-4" />
            恢复项目
          </Button>
        ) : (
          <Button
            variant="outline"
            size="md"
            loading={archive.isPending}
            disabled={!ctx.permissions.canArchive}
            onClick={() => archive.mutate()}
          >
            <Archive className="size-4" />
            归档项目
          </Button>
        )}
      </div>
    </div>
  );
}

export default function ProjectOverviewPage() {
  return (
    <ProjectShell>
      <OverviewContent />
    </ProjectShell>
  );
}
