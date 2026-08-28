// V2 Create Project page (M01-S). Minimal creation flow.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft, FolderPlus } from 'lucide-react';
import { qk } from '@/shared/state/queryClient';
import { v2project } from '@/shared/api/contract/project-client';
import { Button } from '@/shared/ui/v2/Button';
import { Input } from '@/shared/ui/v2/Input';
import { Textarea } from '@/shared/ui/v2/Input';
import { Select } from '@/shared/ui/v2/Select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/shared/ui/v2/Card';
import { LoadingState, ErrorState } from '@/shared/ui/v2/states';

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
      }),
    onSuccess: (detail) => {
      navigate(`/__v2/projects/${detail.project.id}`);
    },
  });

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
              disabled={!canSubmit}
              onClick={() => create.mutate()}
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
