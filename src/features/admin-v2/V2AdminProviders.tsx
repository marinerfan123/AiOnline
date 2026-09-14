// ── V2 Admin · Providers list (M02-B) ───────────────────────────────────────
// Real API (v2ai), M00 design system. No mock. Admin-only (RequireAdminV2).
// UX states: loading / empty / error / search + filter / enable-disable.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Server, Search } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/v2/Card';
import { Button } from '@/shared/ui/v2/Button';
import { Input } from '@/shared/ui/v2/Input';
import { Select } from '@/shared/ui/v2/Select';
import { DataTable, type Column } from '@/shared/ui/v2/DataTable';
import { Badge } from '@/shared/ui/v2/Badge';
import { StatusBadge } from '@/shared/ui/v2/StatusBadge';
import { EmptyState, ErrorState } from '@/shared/ui/v2/states';
import { toast } from '@/shared/ui/v2/Toast';
import { v2ai, AiControlApiError, type ProviderView } from '@/shared/api/contract/ai-control-client';

export function V2AdminProvidersPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [enabled, setEnabled] = useState<'all' | 'true' | 'false'>('all');

  const params = useMemo(() => ({
    q: q || undefined,
    enabled: enabled === 'all' ? undefined : (enabled as 'true' | 'false'),
  }), [q, enabled]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['v2ai', 'providers', params],
    queryFn: () => v2ai.listProviders(params),
    retry: 0,
    staleTime: 5_000,
  });

  const createMut = useMutation({
    mutationFn: (body: { id: string; name: string; baseUrl: string }) => v2ai.createProvider(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v2ai', 'providers'] });
      toast('服务商已创建', { description: '可进入详情页配置密钥池。' });
    },
    onError: (e: unknown) => toast.error('创建失败', { description: errMsg(e) }),
  });

  const toggleMut = useMutation({
    mutationFn: async (p: ProviderView) => v2ai.setProviderEnabled(p.id, !p.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2ai', 'providers'] }),
    onError: (e: unknown) => toast.error('操作失败', { description: errMsg(e) }),
  });

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ id: '', name: '', baseUrl: '' });

  const columns: Column<ProviderView>[] = [
    { key: 'name', header: '服务商', render: (p) => (
      <div className="flex items-center gap-2">
        <Server className="size-4 text-ml2-text-3" />
        <div>
          <div className="font-medium">{p.name}</div>
          <div className="text-xs text-ml2-text-3">{p.id}</div>
        </div>
      </div>
    ) },
    { key: 'protocol', header: '协议', render: (p) => <span className="text-xs">{p.protocol}</span> },
    { key: 'enabled', header: '状态', render: (p) => (
      <StatusBadge status={p.enabled ? 'active' : 'disabled'} label={p.enabled ? '启用' : '停用'} />
    ) },
    { key: 'models', header: '模型', align: 'right', render: (p) => <span className="text-ml2-text-2">{(p.models || []).length}</span> },
    { key: 'bindings', header: '线路', align: 'right', render: (p) => <span className="text-ml2-text-2">{(p.bindings || []).length}</span> },
    { key: 'keys', header: '密钥池', align: 'right', render: (p) => (
      <div className="flex items-center justify-end gap-2">
        <span className="text-ml2-text-2">{p.key_pool_count ?? 0} 把</span>
        <CredentialBadge source={p.credential_source?.source} />
      </div>
    ) },
    { key: 'actions', header: '', align: 'right', render: (p) => (
      <div className="flex items-center justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => toggleMut.mutate(p)} disabled={toggleMut.isPending} data-test={`toggle-${p.id}`}>
          {p.enabled ? '停用' : '启用'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => navigate(`/__v2/admin/providers/${p.id}`)} data-test={`open-${p.id}`}>
          详情
        </Button>
      </div>
    ) },
  ];

  if (isError) {
    return <div className="p-6"><ErrorState description={errMsg(error)} onRetry={() => refetch()} /></div>;
  }

  return (
    <div className="p-6 space-y-4" data-test="v2-admin-providers">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">服务商与密钥池</h1>
          <p className="text-sm text-ml2-text-3">AI Control Plane · 供应商管理（密钥仅显示掩码指纹）</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => refetch()} data-test="providers-refresh">
            <RefreshCw className="size-4" />
          </Button>
          <Button onClick={() => setCreating((v) => !v)} data-test="providers-create-open">
            <Plus className="size-4" /> 新建服务商
          </Button>
        </div>
      </div>

      {creating && (
        <Card data-test="providers-create-card">
          <CardHeader>
            <CardTitle>新建服务商</CardTitle>
            <CardDescription>id 为线路主键，创建后不可更改。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <Input placeholder="id（如 agnes）" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} data-test="prov-id" />
            <Input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-test="prov-name" />
            <Input placeholder="base_url（可选）" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} data-test="prov-baseurl" />
            <div className="sm:col-span-3 flex gap-2">
              <Button
                disabled={!form.id.trim() || !form.name.trim() || createMut.isPending}
                onClick={() => createMut.mutate({ id: form.id.trim(), name: form.name.trim(), baseUrl: form.baseUrl.trim() })}
                data-test="prov-create-submit"
              >
                创建
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>取消</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-ml2-text-3" />
          <Input className="pl-8" placeholder="搜索 id / 名称 / 协议" value={q} onChange={(e) => setQ(e.target.value)} data-test="providers-search" />
        </div>
        <Select
          value={enabled}
          onValueChange={(v) => setEnabled(v as 'all' | 'true' | 'false')}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'true', label: '仅启用' },
            { value: 'false', label: '仅停用' },
          ]}
          data-test="providers-filter"
        />
      </div>

      <DataTable
        columns={columns}
        rows={data?.providers ?? []}
        rowKey={(p) => p.id}
        loading={isLoading}
        onRowClick={(p) => navigate(`/__v2/admin/providers/${p.id}`)}
        empty={
          <EmptyState
            icon={Server}
            title="还没有服务商"
            description="点击右上角「新建服务商」开始。"
            action={{ label: '新建服务商', onClick: () => setCreating(true) }}
          />
        }
      />
    </div>
  );
}

function CredentialBadge({ source }: { source?: string }) {
  if (source === 'POOL') return <Badge tone="success">密钥池</Badge>;
  if (source === 'LEGACY_FALLBACK') return <Badge tone="warning">遗留回退</Badge>;
  return <Badge tone="neutral">无密钥</Badge>;
}

function errMsg(e: unknown) {
  if (e instanceof AiControlApiError) {
    if (e.status === 403) return '无权限（需管理员）';
    if (e.status === 404) return '资源不存在';
    if (e.status === 409) return '冲突：数据已被其他管理员修改，请刷新重试';
  }
  return e instanceof Error ? e.message : '请求失败';
}
