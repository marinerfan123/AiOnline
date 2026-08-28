// V2 Projects list page (M01-S). Creative directory, not an admin table.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FolderKanban, Plus, Search, FolderOpen } from 'lucide-react';
import { qk } from '@/shared/state/queryClient';
import { v2project } from '@/shared/api/contract/project-client';
import { Button } from '@/shared/ui/v2/Button';
import { Input } from '@/shared/ui/v2/Input';
import { Select } from '@/shared/ui/v2/Select';
import { Card, CardContent } from '@/shared/ui/v2/Card';
import { StatusBadge } from '@/shared/ui/v2/StatusBadge';
import { EmptyState, LoadingState, ErrorState } from '@/shared/ui/v2/states';
import type { ProjectSummary } from '@/shared/api/contract/schemas';

const TYPE_OPTIONS = [
  { value: '', label: '所有类型' },
  { value: 'general', label: '通用' },
  { value: 'studio', label: 'Studio' },
  { value: 'short_drama', label: '短剧' },
];

const STATUS_OPTIONS = [
  { value: '', label: '所有状态' },
  { value: 'active', label: '活跃' },
  { value: 'draft', label: '草稿' },
  { value: 'archived', label: '已归档' },
];

function formatUpdatedAt(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('zh-CN');
  } catch {
    return iso;
  }
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(`/__v2/projects/${project.id}`)}
      className="flex w-full flex-col rounded-lg border border-ml2-border bg-ml2-surface-1 p-4 text-left transition-colors hover:border-ml2-accent hover:bg-ml2-surface-2"
      data-test="project-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="grid size-9 shrink-0 place-items-center rounded-md bg-ml2-accent text-sm font-bold text-ml2-on-accent">
          {project.name.slice(0, 1).toUpperCase()}
        </div>
        <StatusBadge
          status={project.status === 'active' ? 'active' : project.status === 'archived' ? 'disabled' : 'queued'}
          label={project.status}
        />
      </div>
      <h3 className="mt-3 line-clamp-1 text-sm font-semibold text-ml2-text">{project.name}</h3>
      {project.description && (
        <p className="mt-1 line-clamp-2 text-xs text-ml2-text-3">{project.description}</p>
      )}
      <div className="mt-auto pt-3 text-xs text-ml2-text-3">
        <span className="capitalize">{project.projectType}</span>
        <span className="mx-1.5">·</span>
        <span>{formatUpdatedAt(project.updatedAt)}</span>
      </div>
    </button>
  );
}

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [projectType, setProjectType] = useState('');

  const query = useMemo(
    () => ({
      search: search.trim(),
      status: status as 'draft' | 'active' | 'archived' | '',
      projectType: projectType as 'general' | 'studio' | 'short_drama' | '',
      limit: 20,
      offset: 0,
    }),
    [search, status, projectType],
  );

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['projects', query],
    queryFn: () => v2project.listProjects(query),
    staleTime: 10_000,
  });

  const projects = data?.projects ?? [];
  const hasArchivedFilter = status === 'archived';

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-ml2-text">
            <FolderKanban className="size-5" />
            Projects
          </h1>
          <p className="text-xs text-ml2-text-3">创作项目总览 · 最近更新优先</p>
        </div>
        <Button size="md" onClick={() => navigate('/__v2/projects/new')} data-test="create-project">
          <Plus className="size-4" />
          新建项目
        </Button>
      </div>

      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ml2-text-3" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索项目名称或描述"
              className="pl-9"
              data-test="project-search"
            />
          </div>
          <Select
            value={status}
            onValueChange={setStatus}
            options={STATUS_OPTIONS}
            placeholder="状态"
            className="w-full sm:w-36"
          />
          <Select
            value={projectType}
            onValueChange={setProjectType}
            options={TYPE_OPTIONS}
            placeholder="类型"
            className="w-full sm:w-36"
          />
        </CardContent>
      </Card>

      {isLoading && <LoadingState label="加载项目中…" />}

      {!isLoading && error && (
        <ErrorState
          title="加载项目失败"
          description={(error as Error).message}
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !error && projects.length === 0 && (
        <Card>
          <CardContent>
            <EmptyState
              icon={FolderOpen}
              title={hasArchivedFilter ? '没有已归档项目' : '还没有项目'}
              description={
                hasArchivedFilter
                  ? '当前没有已归档的项目。'
                  : '创建第一个项目开始创作。'
              }
              action={{ label: '新建项目', onClick: () => navigate('/__v2/projects/new') }}
            />
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}
