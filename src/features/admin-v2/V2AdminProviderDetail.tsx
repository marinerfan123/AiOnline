// ── V2 Admin · Provider detail + Key Pool (M02-B) ──────────────────────────
// Real API (v2ai), M00 design system. No mock. Admin-only.
// Overview, credential source (POOL / LEGACY_FALLBACK / NONE), bindings summary,
// and full key-pool management (add/batch/edit/cooldown/delete). Masked-only
// secret display; the full key is never re-read after creation.
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Plus, RefreshCw, Trash2, Wand2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/v2/Card';
import { Button } from '@/shared/ui/v2/Button';
import { Input, Textarea } from '@/shared/ui/v2/Input';
import { Select } from '@/shared/ui/v2/Select';
import { Dialog, DialogContent } from '@/shared/ui/v2/Dialog';
import { ConfirmDialog } from '@/shared/ui/v2/ConfirmDialog';
import { DataTable, type Column } from '@/shared/ui/v2/DataTable';
import { Badge } from '@/shared/ui/v2/Badge';
import { StatusBadge } from '@/shared/ui/v2/StatusBadge';
import { EmptyState, ErrorState } from '@/shared/ui/v2/states';
import { toast } from '@/shared/ui/v2/Toast';
import {
  v2ai, AiControlApiError,
  type ProviderView, type MaskedKey,
} from '@/shared/api/contract/ai-control-client';

export function V2AdminProviderDetailPage() {
  const { providerId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['v2ai', 'provider', providerId],
    queryFn: () => v2ai.getProvider(providerId),
    retry: 0,
    staleTime: 5_000,
    enabled: !!providerId,
  });
  const provider: ProviderView | undefined = data?.provider;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['v2ai', 'provider', providerId] });
    qc.invalidateQueries({ queryKey: ['v2ai', 'providers'] });
  };

  if (isError) {
    return <div className="p-6"><ErrorState description={errMsg(error)} onRetry={() => refetch()} /></div>;
  }
  if (isLoading || !provider) {
    return <div className="p-6 text-sm text-ml2-text-3" data-test="provider-detail-loading">加载中…</div>;
  }

  return (
    <div className="p-6 space-y-4" data-test="v2-admin-provider-detail">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/__v2/admin/providers')} data-test="detail-back">
          <ArrowLeft className="size-4" /> 返回服务商列表
        </Button>
        <Button variant="ghost" size="sm" onClick={() => refetch()}>
          <RefreshCw className="size-4" /> 刷新
        </Button>
      </div>

      <div>
        <h1 className="text-xl font-semibold">{provider.name}</h1>
        <p className="text-sm text-ml2-text-3">{provider.id} · {provider.protocol}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>凭据来源（Credential Source）</CardTitle>
          <CardDescription>
            运行时密钥选择：api_keys 密钥池优先；池为空时回退 providers.api_key（遗留列）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CredentialSourcePanel provider={provider} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>密钥池（{provider.key_pool_count ?? 0} 把）</CardTitle>
          <CardDescription>仅显示掩码指纹；创建后完整密钥不可再读取。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <KeyPoolTable provider={provider} onChanged={invalidate} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>线路（Bindings）</CardTitle>
          <CardDescription>逻辑模型 × 本服务商的绑定摘要。</CardDescription>
        </CardHeader>
        <CardContent>
          <BindingsSummary provider={provider} />
        </CardContent>
      </Card>
    </div>
  );
}

function CredentialSourcePanel({ provider }: { provider: ProviderView }) {
  const src = provider.credential_source?.source;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {src === 'POOL' && (
        <span className="flex items-center gap-2">
          <StatusBadge status="active" label="密钥池生效" />
          <span className="text-sm text-ml2-text-2">
            {provider.active_key_count ?? 0} 把可用 / 共 {provider.key_pool_count ?? 0} 把
          </span>
        </span>
      )}
      {src === 'LEGACY_FALLBACK' && (
        <span className="flex items-center gap-2">
          <Badge tone="warning">遗留回退生效</Badge>
          <span className="text-sm text-ml2-text-2">
            密钥池无可用密钥，正在使用 providers.api_key（{provider.credential?.masked_legacy_key}）
          </span>
        </span>
      )}
      {src === 'NONE' && (
        <span className="flex items-center gap-2">
          <Badge tone="danger">无可用凭据</Badge>
          <span className="text-sm text-ml2-text-2">
            该服务商当前无法出站，请添加密钥或配置 base_url/api_key。
          </span>
        </span>
      )}
      <span className="ml-auto text-xs text-ml2-text-3">
        遗留密钥：{provider.credential?.has_legacy_key ? `存在（${provider.credential?.masked_legacy_key}）` : '未配置'}
      </span>
    </div>
  );
}
function KeyPoolTable({ provider, onChanged }: { provider: ProviderView; onChanged: () => void }) {
  const pid = provider.id;
  const [addOpen, setAddOpen] = useState(false);
  const [editKey, setEditKey] = useState<MaskedKey | null>(null);
  const [deleteKey, setDeleteKey] = useState<MaskedKey | null>(null);

  const addMut = useMutation({
    mutationFn: (body: { apiKey?: string; keys?: string; label: string }) => v2ai.addKeys(pid, body),
    onSuccess: (r) => {
      onChanged();
      toast('密钥已添加', {
        description: `新增 ${r.added} 把，去重跳过 ${r.skipped} 把，共 ${r.total} 把。`,
      });
      setAddOpen(false);
    },
    onError: (e: unknown) => toast.error('添加失败', { description: errMsg(e) }),
  });
  const editMut = useMutation({
    mutationFn: (body: { keyId: string; patch: Record<string, unknown> }) =>
      v2ai.updateKey(pid, body.keyId, body.patch),
    onSuccess: () => {
      onChanged();
      toast('密钥已更新');
      setEditKey(null);
    },
    onError: (e: unknown) => toast.error('更新失败', { description: errMsg(e) }),
  });
  const delMut = useMutation({
    mutationFn: (keyId: string) => v2ai.deleteKey(pid, keyId),
    onSuccess: () => {
      onChanged();
      toast('密钥已删除');
      setDeleteKey(null);
    },
    onError: (e: unknown) => toast.error('删除失败', { description: errMsg(e) }),
  });
  const coolMut = useMutation({
    mutationFn: (body: { keyId: string; ms: number }) => v2ai.setKeyCooldown(pid, body.keyId, body.ms),
    onSuccess: (r) => {
      onChanged();
      toast(r.cooldown_until ? '冷却已设置' : '冷却已清除');
    },
    onError: (e: unknown) => toast.error('操作失败', { description: errMsg(e) }),
  });

  const keys = provider.key_pool ?? [];
  const allDisabled = keys.length > 0 && keys.every((k) => !k.enabled);
  const allCooling = keys.length > 0 && keys.every((k) => k.cooldown_until && new Date(k.cooldown_until).getTime() > Date.now());

  const columns: Column<MaskedKey>[] = [
    { key: 'masked', header: '指纹', render: (k) => (
      <code className="text-xs">{k.masked || '—'}</code>
    ) },
    { key: 'label', header: '标签', render: (k) => <span className="text-xs">{k.label || '—'}</span> },
    { key: 'enabled', header: '状态', render: (k) => (
      <StatusBadge status={k.enabled ? 'active' : 'disabled'} label={k.enabled ? '启用' : '停用'} />
    ) },
    { key: 'weight', header: '权重', align: 'right', render: (k) => <span className="text-ml2-text-2">{k.weight ?? 100}</span> },
    { key: 'rpm', header: 'RPM', align: 'right', render: (k) => <span className="text-ml2-text-2">{k.rpm ?? '—'}</span> },
    { key: 'concurrency', header: '并发', align: 'right', render: (k) => <span className="text-ml2-text-2">{k.concurrency ?? '—'}</span> },
    { key: 'health', header: '健康', render: (k) => <KeyHealthBadge k={k} /> },
    { key: 'last', header: '最近使用', render: (k) => (
      <span className="text-xs text-ml2-text-3">
        {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}
        {k.last_error_code ? <span className="text-ml2-danger"> · {k.last_error_code}</span> : null}
      </span>
    ) },
    { key: 'actions', header: '', align: 'right', render: (k) => (
      <div className="flex items-center justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => coolMut.mutate({ keyId: k.id!, ms: k.cooldown_until ? 0 : 60_000 })} data-test={`cool-${k.id}`}>
          {k.cooldown_until ? '解除冷却' : '冷却60s'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditKey(k)} data-test={`edit-${k.id}`}>
          编辑
        </Button>
        <Button variant="ghost" size="sm" className="text-ml2-danger" onClick={() => setDeleteKey(k)} data-test={`del-${k.id}`}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    ) },
  ];

  return (
    <div className="space-y-2" data-test="keypool">
      {allDisabled && <Notice tone="danger">密钥池全部停用 — 该服务商将无法出站（除非存在遗留回退）。</Notice>}
      {allCooling && <Notice tone="warning">密钥池全部冷却中 — 稍后自动恢复。</Notice>}
      <div className="flex items-center justify-end gap-2">
        <Button onClick={() => setAddOpen(true)} data-test="key-add-open">
          <Plus className="size-4" /> 添加密钥
        </Button>
      </div>
      <DataTable
        columns={columns}
        rows={keys}
        rowKey={(k) => k.id ?? k.masked}
        empty={<EmptyState icon={KeyRound} title="密钥池为空" description="点击右上角「添加密钥」开始。" action={{ label: '添加密钥', onClick: () => setAddOpen(true) }} />}
      />

      <AddKeyDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSubmit={(b) => addMut.mutate(b)}
        pending={addMut.isPending}
      />
      {editKey && (
        <EditKeyDialog
          key={editKey.id}
          k={editKey}
          onClose={() => setEditKey(null)}
          onSave={(patch) => editMut.mutate({ keyId: editKey.id!, patch })}
          pending={editMut.isPending}
        />
      )}
      <ConfirmDialog
        open={!!deleteKey}
        onOpenChange={(v) => !v && setDeleteKey(null)}
        title="删除密钥"
        description={deleteKey ? `确定删除 ${deleteKey.masked}（${deleteKey.label || '无标签'}）？此操作不可撤销。` : ''}
        confirmLabel="删除"
        tone="danger"
        loading={delMut.isPending}
        onConfirm={() => deleteKey && delMut.mutate(deleteKey.id!)}
      />
    </div>
  );
}

function AddKeyDialog({
  open, onOpenChange, onSubmit, pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (b: { apiKey?: string; keys?: string; label: string }) => void;
  pending: boolean;
}) {
  const [single, setSingle] = useState('');
  const [batch, setBatch] = useState('');
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<'single' | 'batch'>('batch');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="添加密钥" className="max-w-lg">
        <div className="space-y-3">
          <div className="flex gap-2">
            <Button variant={mode === 'batch' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode('batch')}>批量（每行一把）</Button>
            <Button variant={mode === 'single' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode('single')}>单把</Button>
          </div>
          {mode === 'single' ? (
            <Input
              value={single}
              onChange={(e) => setSingle(e.target.value)}
              placeholder="粘贴 API Key"
              type="password"
              data-test="addkey-single"
            />
          ) : (
            <Textarea
              value={batch}
              onChange={(e) => setBatch(e.target.value)}
              placeholder={'每行一把 API Key，例如：\nsk-xxxx1\nsk-xxxx2'}
              rows={6}
              data-test="addkey-batch"
            />
          )}
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="标签（可选）"
            data-test="addkey-label"
          />
          <p className="text-xs text-ml2-text-3">
            提示：创建后密钥只保存不可再读取（掩码指纹 {single ? `••••${single.slice(-4)}` : '••••••••'}）。
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
            <Button
              loading={pending}
              disabled={mode === 'single' ? !single.trim() : !batch.trim()}
              onClick={() => {
                onSubmit(mode === 'single'
                  ? { apiKey: single.trim(), label }
                  : { keys: batch, label });
                setSingle(''); setBatch(''); setLabel('');
              }}
              data-test="addkey-submit"
            >
              <Wand2 className="size-4" /> 添加
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditKeyDialog({
  k, onClose, onSave, pending,
}: {
  k: MaskedKey;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [label, setLabel] = useState(k.label ?? '');
  const [weight, setWeight] = useState(String(k.weight ?? 100));
  const [rpm, setRpm] = useState(k.rpm != null ? String(k.rpm) : '');
  const [concurrency, setConc] = useState(k.concurrency != null ? String(k.concurrency) : '');
  const [status, setStatus] = useState(k.enabled ? 'active' : 'disabled');

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={`编辑密钥 ${k.masked}`} className="max-w-lg">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-ml2-text-3">标签</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} data-test="editkey-label" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-xs text-ml2-text-3">权重</label>
              <Input type="number" value={weight} onChange={(e) => setWeight(e.target.value)} data-test="editkey-weight" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-ml2-text-3">RPM</label>
              <Input type="number" value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="—" data-test="editkey-rpm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-ml2-text-3">并发</label>
              <Input type="number" value={concurrency} onChange={(e) => setConc(e.target.value)} placeholder="—" data-test="editkey-conc" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-ml2-text-3">状态</label>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v)}
              options={[
                { value: 'active', label: '启用' },
                { value: 'disabled', label: '停用' },
              ]}
              data-test="editkey-status"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button loading={pending} data-test="editkey-save" onClick={() => onSave({
              label,
              weight: Math.max(0, parseInt(weight, 10) || 0),
              rpm: rpm ? Math.max(1, parseInt(rpm, 10)) : null,
              concurrency: concurrency ? Math.max(1, parseInt(concurrency, 10)) : null,
              status,
            })}>
              保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function KeyHealthBadge({ k }: { k: MaskedKey }) {
  const cooling = k.cooldown_until && new Date(k.cooldown_until).getTime() > Date.now();
  const health = k.health ?? 'UNKNOWN';
  const map: Record<string, { status: 'healthy' | 'degraded' | 'down' | 'queued' | 'disabled'; label: string }> = {
    HEALTHY: { status: 'healthy', label: '健康' },
    DEGRADED: { status: 'degraded', label: '降级' },
    UNHEALTHY: { status: 'down', label: '异常' },
    DISABLED: { status: 'disabled', label: '停用' },
    UNKNOWN: { status: 'queued', label: '未知' },
  };
  if (cooling) return <StatusBadge status="processing" label="冷却中" />;
  const m = map[health] ?? map.UNKNOWN;
  return <StatusBadge status={m.status} label={m.label} />;
}

function Notice({ tone, children }: { tone: 'danger' | 'warning'; children: React.ReactNode }) {
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${
      tone === 'danger'
        ? 'border-ml2-danger/40 bg-ml2-danger-dim text-ml2-danger'
        : 'border-ml2-warning/40 bg-ml2-warning-dim text-ml2-warning'
    }`}>
      {children}
    </div>
  );
}

function BindingsSummary({ provider }: { provider: ProviderView }) {
  const bindings = provider.bindings ?? [];
  if (!bindings.length) {
    return <EmptyState title="暂无线路绑定" description="该服务商还没有绑定任何逻辑模型。" />;
  }
  const rows = bindings.map((b) => (
    <tr key={b.binding_id} className="border-b border-ml2-border/50 last:border-0">
      <td className="px-3 py-2 text-sm">{b.model_name || b.model_id}</td>
      <td className="px-3 py-2 text-xs text-ml2-text-3">{b.provider_model_code}</td>
      <td className="px-3 py-2 text-right text-xs">{b.enabled ? '启用' : '停用'}</td>
      <td className="px-3 py-2 text-right text-xs">{b.priority}</td>
      <td className="px-3 py-2 text-right text-xs">{b.weight}</td>
    </tr>
  ));
  return (
    <div className="overflow-x-auto rounded-lg border border-ml2-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-ml2-border bg-ml2-surface-2 text-xs text-ml2-text-3">
            <th className="px-3 py-2 text-left font-semibold">模型</th>
            <th className="px-3 py-2 text-left font-semibold">上游代码</th>
            <th className="px-3 py-2 text-right font-semibold">状态</th>
            <th className="px-3 py-2 text-right font-semibold">优先级</th>
            <th className="px-3 py-2 text-right font-semibold">权重</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

function errMsg(e: unknown) {
  if (e instanceof AiControlApiError) {
    if (e.status === 403) return '无权限（需管理员）';
    if (e.status === 404) return '资源不存在';
    if (e.status === 409) return '冲突：数据已被其他管理员修改，请刷新重试';
  }
  return e instanceof Error ? e.message : '请求失败';
}
