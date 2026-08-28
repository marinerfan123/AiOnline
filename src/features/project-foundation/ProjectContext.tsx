// ProjectContext — stable project identity for all downstream V2 modules.
// Provides projectId, workspaceId, project metadata, and permissions.
// Does NOT put the full project object in global state (per M11-state-architecture).

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { useParams } from 'react-router-dom';
import { v2project } from '@/shared/api/contract/project-client';
import { useAppStore } from '@/shared/state/appStore';
import type { ProjectDetail, ProjectSummary, ProjectPermissions } from '@/shared/api/contract/schemas';

export interface ProjectContextValue {
  projectId: string;
  workspaceId: string;
  projectType: ProjectSummary['projectType'];
  projectName: string;
  projectStatus: ProjectSummary['status'];
  permissions: ProjectPermissions;
  project: ProjectSummary | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjectContext() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProjectContext must be used within ProjectProvider');
  return ctx;
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setProject = useAppStore((s) => s.setProject);

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setError('缺少项目 ID');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const d = await v2project.getProject(projectId);
      setDetail(d);
      setWorkspace(d.project.workspaceId);
      setProject(d.project.id);
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 404) setError('项目不存在');
      else if (err.status === 403) setError('无权访问该项目');
      else setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, setWorkspace, setProject]);

  useEffect(() => {
    load();
  }, [load]);

  const value: ProjectContextValue = {
    projectId: projectId ?? '',
    workspaceId: detail?.project.workspaceId ?? '',
    projectType: detail?.project.projectType ?? 'general',
    projectName: detail?.project.name ?? '',
    projectStatus: detail?.project.status ?? 'draft',
    permissions: detail?.permissions ?? {
      role: 'member',
      canRead: false,
      canUpdate: false,
      canArchive: false,
      canRestore: false,
      canDelete: false,
    },
    project: detail?.project ?? null,
    loading,
    error,
    reload: load,
  };

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}
