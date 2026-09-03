// ── W1-06 — Creative Brief edit panel (Overview page) ─────────────────────────
// Reads the project's persisted creative_brief (via ProjectContext), renders the
// editable form, validates client-side and persists via v2project.updateProject
// (PATCH /api/v2/projects/:id). On success the project is reloaded so the
// persisted brief is re-read and echoed exactly on re-open. Rejects unsupported
// combinations (platform) and missing required fields with clear messages, and
// preserves the user's input when the server rejects the payload.

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText } from 'lucide-react';
import { v2project, ProjectApiError } from '@/shared/api/contract/project-client';
import type { UpdateProjectRequest } from '@/shared/api/contract/schemas';
import { Button } from '@/shared/ui/v2/Button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/shared/ui/v2/Card';
import { BriefForm } from './BriefForm';
import {
  type CreativeBriefDraft,
  type CreativeBriefFormErrors,
  DEFAULT_DRAFT,
  briefToDraft,
  validateDraft,
} from './creativeBriefDraft';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';

interface BriefPanelProps {
  projectId: string;
  /** Allow editing/saving (drive from project permissions). */
  canUpdate: boolean;
}

export function BriefPanel({ projectId, canUpdate }: BriefPanelProps) {
  const ctx = useProjectContext();
  const [draft, setDraft] = useState<CreativeBriefDraft>(DEFAULT_DRAFT);
  const [seeded, setSeeded] = useState(false);
  const [errors, setErrors] = useState<CreativeBriefFormErrors | null>(null);

  // Seed the form from the persisted brief exactly once it is available; after a
  // save we re-seed so the panel echoes the sanitized server value (exact echo).
  useEffect(() => {
    if (!seeded && ctx.project?.creative_brief !== undefined) {
      setDraft(briefToDraft(ctx.project.creative_brief));
      setSeeded(true);
    }
  }, [seeded, ctx.project]);

  const save = useMutation({
    mutationFn: (body: UpdateProjectRequest) => v2project.updateProject(projectId, body),
    onSuccess: (detail) => {
      setErrors(null);
      toast.success('创意简报已保存');
      // Re-seed from the sanitized value returned by the server so the panel
      // echoes the persisted brief exactly (exact echo), then refresh context.
      setDraft(briefToDraft(detail.project.creative_brief));
      ctx.reload();
    },
    onError: (e) => {
      if (e instanceof ProjectApiError && e.status === 400) {
        const message = String((e.payload as { error?: string } | undefined)?.error ?? e.message);
        setErrors({ fields: {}, global: [message] });
      } else {
        toast.error(e instanceof Error ? e.message : '保存创意简报失败');
      }
    },
  });

  const handleSave = () => {
    const result = validateDraft(draft);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    if (result.brief) save.mutate({ creativeBrief: result.brief });
  };

  return (
    <Card data-test="brief-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="size-4 text-ml2-accent" />
          创意简报（Creative Brief）
        </CardTitle>
        <CardDescription>
          定义项目创作输入（目标、受众、平台、时长、比例、语言、风格、参考、预算、截止、交付物、限制）。保存后重新打开会精确回显。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <BriefForm
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            setErrors(null);
          }}
          errors={errors ?? undefined}
          disabled={!canUpdate}
        />
        {canUpdate && (
          <div className="flex justify-end gap-2 pt-1">
            <Button
              size="md"
              loading={save.isPending}
              disabled={save.isPending}
              onClick={handleSave}
              data-test="brief-save"
            >
              保存创意简报
            </Button>
          </div>
        )}
        {!canUpdate && (
          <p className="text-xs text-ml2-text-3" data-test="brief-readonly-note">
            你只有只读权限，无法编辑创意简报。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
