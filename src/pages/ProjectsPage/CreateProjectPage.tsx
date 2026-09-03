// V2 Create Project page (M01-S). Minimal creation flow.

import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft, FolderPlus, Clapperboard, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { qk } from '@/shared/state/queryClient';
import { v2project } from '@/shared/api/contract/project-client';
import { v2deliverySpec, DeliverySpecApiError } from '@/shared/api/contract/delivery-spec-client';
import type { CreativeBrief } from '@/shared/api/contract/schemas';
import { Button } from '@/shared/ui/v2/Button';
import { Input } from '@/shared/ui/v2/Input';
import { Textarea } from '@/shared/ui/v2/Input';
import { Select } from '@/shared/ui/v2/Select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/shared/ui/v2/Card';
import { LoadingState, ErrorState } from '@/shared/ui/v2/states';
import { DeliverySpecForm } from './DeliverySpecForm';
import {
  type DeliverySpecDraft,
  type DeliverySpecFormErrors,
  DEFAULT_DRAFT,
  validateDraft,
} from './deliverySpecDraft';
import { BriefForm } from './BriefForm';
import {
  type CreativeBriefDraft,
  type CreativeBriefFormErrors,
  DEFAULT_DRAFT as BRIEF_DEFAULT_DRAFT,
  validateDraft as validateBriefDraft,
} from './creativeBriefDraft';

const TYPE_OPTIONS = [
  { value: 'general', label: '通用项目' },
  { value: 'studio', label: 'Studio 项目' },
  { value: 'short_drama', label: '短剧项目' },
];

export default function CreateProjectPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectType, setProjectType] = useState('general');
  const [draft, setDraft] = useState<DeliverySpecDraft>(DEFAULT_DRAFT);
  const [specErrors, setSpecErrors] = useState<DeliverySpecFormErrors | null>(null);
  const [briefDraft, setBriefDraft] = useState<CreativeBriefDraft>(BRIEF_DEFAULT_DRAFT);
  const [briefErrors, setBriefErrors] = useState<CreativeBriefFormErrors | null>(null);
  const briefPayload = useRef<CreativeBrief | null>(null);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => v2project.listWorkspaces(),
    staleTime: 60_000,
  });

  const workspaceOptions = useMemo(
    () =>
      (workspacesQuery.data?.workspaces ?? []).map((w) => ({
        value: w.id,
        label: w.name,
      })),
    [workspacesQuery.data],
  );

  const [workspaceId, setWorkspaceId] = useState('');

  // Default to the first workspace once loaded.
  if (workspaceId === '' && workspaceOptions.length > 0) {
    setWorkspaceId(workspaceOptions[0].value);
  }

  const create = useMutation({
    mutationFn: () =>
      v2project.createProject({
        workspaceId,
        name,
        description,
        projectType: projectType as 'general' | 'studio' | 'short_drama',
        creativeBrief: briefPayload.current ?? undefined,
      }),
    onSuccess: async (detail) => {
      // Persist the DeliverySpec right after the project exists (W1-07). The
      // spec is validated client-side before submit; if the server still rejects
      // it, surface a clear message but still land on the project so it can be
      // fixed in the Overview.
      const result = validateDraft(draft);
      if (result.spec) {
        try {
          await v2deliverySpec.upsert(detail.project.id, result.spec);
        } catch (e) {
          const msg =
            e instanceof DeliverySpecApiError
              ? String((e.body as { error?: string })?.error ?? e.message)
              : e instanceof Error
                ? e.message
                : '保存交付规格失败';
          toast.error(msg);
        }
      }
      navigate(`/__v2/projects/${detail.project.id}`);
    },
  });

  const handleSubmit = () => {
    const result = validateDraft(draft);
    if (result.errors) {
      setSpecErrors(result.errors);
      return;
    }
    const briefResult = validateBriefDraft(briefDraft);
    if (briefResult.errors) {
      setBriefErrors(briefResult.errors);
      return;
    }
    setSpecErrors(null);
    setBriefErrors(null);
    briefPayload.current = briefResult.brief ?? null;
    create.mutate();
  };

  const canSubmit = name.trim().length > 0 && workspaceId !== '';

  if (workspacesQuery.isLoading) return <LoadingState label="加载工作空间中…" />;
  if (workspacesQuery.error) {
    return (
      <ErrorState
        title="无法加载工作空间"
        description={(workspacesQuery.error as Error).message}
        onRetry={() => workspacesQuery.refetch()}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <button
        onClick={() => navigate('/__v2/projects')}
        className="mb-4 inline-flex w-fit items-center gap-1 text-xs text-ml2-text-3 hover:text-ml2-text"
      >
        <ChevronLeft className="size-4" />
        返回项目列表
      </button>

      <Card className="mx-auto w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderPlus className="size-5" />
            新建项目
          </CardTitle>
          <CardDescription>创建一个新项目作为 Studio / 短剧 / 素材的创作边界。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-ml2-text-2">项目名称 *</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：古风短剧第一季"
              maxLength={200}
              data-test="project-name-input"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-ml2-text-2">项目类型</label>
            <Select
              value={projectType}
              onValueChange={setProjectType}
              options={TYPE_OPTIONS}
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-ml2-text-2">工作空间</label>
            <Select
              value={workspaceId}
              onValueChange={setWorkspaceId}
              options={workspaceOptions}
              placeholder="选择工作空间"
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-ml2-text-2">描述（可选）</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要描述项目目标…"
              rows={4}
            />
          </div>

          {/* DeliverySpec (W1-07) — set output requirements before creation */}
          <div className="space-y-2 rounded-md border border-ml2-border bg-ml2-surface-0 p-3">
            <div className="flex items-center gap-2">
              <Clapperboard className="size-4 text-ml2-accent" />
              <span className="text-xs font-semibold text-ml2-text">交付规格</span>
            </div>
            <p className="text-xs text-ml2-text-3">
              定义成片输出要求；保存后重新打开会精确回显。不支持的组合会被拒绝并清晰提示。
            </p>
            <DeliverySpecForm
              draft={draft}
              onChange={(next) => {
                setDraft(next);
                setSpecErrors(null);
              }}
              errors={specErrors ?? undefined}
            />
          </div>

          {/* Creative Brief (W1-06) — set the input contract before creation */}
          <div className="space-y-2 rounded-md border border-ml2-border bg-ml2-surface-0 p-3">
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-ml2-accent" />
              <span className="text-xs font-semibold text-ml2-text">创意简报（Creative Brief）</span>
            </div>
            <p className="text-xs text-ml2-text-3">
              定义项目创作输入；保存后重新打开会精确回显。目标与受众为必填项，缺失或不被支持的组合会被清晰提示。
            </p>
            <BriefForm
              draft={briefDraft}
              onChange={(next) => {
                setBriefDraft(next);
                setBriefErrors(null);
              }}
              errors={briefErrors ?? undefined}
            />
          </div>

          {create.error && (
            <p className="text-xs text-ml2-danger">{(create.error as Error).message}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="md" onClick={() => navigate('/__v2/projects')}>
              取消
            </Button>
            <Button
              size="md"
              loading={create.isPending}
              disabled={!canSubmit || create.isPending}
              onClick={handleSubmit}
              data-test="submit-project"
            >
              创建项目
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
