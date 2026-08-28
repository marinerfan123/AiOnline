// V2 Project Studio placeholder (M01-S). Establishes the Studio entry contract
// from Project Overview. M05-A will replace this with the real Canvas.

import { Clapperboard } from 'lucide-react';
import { ProjectShell } from '@/features/project-foundation/ProjectShell';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/shared/ui/v2/Card';
import { StatusBadge } from '@/shared/ui/v2/StatusBadge';

function StudioPlaceholderContent() {
  return (
    <Card className="mx-auto max-w-2xl" data-test="studio-placeholder">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clapperboard className="size-5" />
          Studio
        </CardTitle>
        <CardDescription>
          从 Project Overview 进入 Studio 的路径已通，真实 Canvas 将在 M05-A 挂载。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <StatusBadge status="queued" label="Coming in Studio Fast Track" />
        <div className="rounded-md border border-dashed border-ml2-border bg-ml2-surface-0 p-6 text-center text-xs text-ml2-text-3">
          本页面仅验证 ProjectContext 已正确解析并通过后端授权。
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProjectStudioPlaceholder() {
  return (
    <ProjectShell>
      <StudioPlaceholderContent />
    </ProjectShell>
  );
}
