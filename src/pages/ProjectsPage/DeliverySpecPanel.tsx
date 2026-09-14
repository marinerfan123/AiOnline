// ── W1-07 — DeliverySpec edit panel (Overview page) ─────────────────────────
// Loads the current spec via v2deliverySpec.get, renders the editable form,
// validates client-side and persists via v2deliverySpec.put. On success the
// query is invalidated so the persisted spec is re-read and echoed exactly on
// re-open. Rejects unsupported combinations with clear messages.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clapperboard } from 'lucide-react';
import {
  v2deliverySpec,
  DeliverySpecApiError,
  type DeliverySpecWriteBody,
} from '@/shared/api/contract/delivery-spec-client';
import { Button } from '@/shared/ui/v2/Button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/shared/ui/v2/Card';
import { LoadingState, ErrorState } from '@/shared/ui/v2/states';
import { DeliverySpecForm } from './DeliverySpecForm';
import {
  type DeliverySpecDraft,
  type DeliverySpecFormErrors,
  DEFAULT_DRAFT,
  specToDraft,
  validateDraft,
} from './deliverySpecDraft';

interface DeliverySpecPanelProps {
  projectId: string;
  /** Allow editing/saving (drive from project permissions). */
  canUpdate: boolean;
}

export function DeliverySpecPanel({ projectId, canUpdate }: DeliverySpecPanelProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DeliverySpecDraft>(DEFAULT_DRAFT);
  const [seeded, setSeeded] = useState(false);
  const [errors, setErrors] = useState<DeliverySpecFormErrors | null>(null);

  const specQuery = useQuery({
    queryKey: ['delivery-spec', projectId],
    queryFn: () => v2deliverySpec.get(projectId),
    staleTime: 30_000,
  });

  // Seed the form from the persisted spec exactly once the first load completes.
  useEffect(() => {
    if (!seeded && specQuery.data) {
      setDraft(specToDraft(specQuery.data.delivery_spec));
      setSeeded(true);
    }
  }, [seeded, specQuery.data]);

  const save = useMutation({
    mutationFn: (spec: DeliverySpecWriteBody) => v2deliverySpec.put(projectId, spec),
    onSuccess: () => {
      setErrors(null);
      toast.success('交付规格已保存');
      // Refetch so the form echoes exactly what the server persisted.
      queryClient.invalidateQueries({ queryKey: ['delivery-spec', projectId] });
    },
    onError: (e) => {
      if (e instanceof DeliverySpecApiError && e.status === 400) {
        const message = String((e.body as { error?: string } | undefined)?.error ?? e.message);
        setErrors({ fields: {}, global: [message] });
      } else {
        toast.error(e instanceof Error ? e.message : '保存交付规格失败');
      }
    },
  });

  const handleSave = () => {
    const result = validateDraft(draft);
    if (result.errors) {
      setErrors(result.errors);
      return;
    }
    if (result.spec) save.mutate(result.spec);
  };

  if (specQuery.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>交付规格</CardTitle>
          <CardDescription>正在加载项目输出规格…</CardDescription>
        </CardHeader>
        <CardContent>
          <LoadingState label="加载中…" />
        </CardContent>
      </Card>
    );
  }

  if (specQuery.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>交付规格</CardTitle>
          <CardDescription>项目输出规格</CardDescription>
        </CardHeader>
        <CardContent>
          <ErrorState
            title="无法加载交付规格"
            description={(specQuery.error as Error).message}
            onRetry={() => specQuery.refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-test="delivery-spec-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clapperboard className="size-4 text-ml2-accent" />
          交付规格
        </CardTitle>
        <CardDescription>
          定义成片输出要求（画面比例、分辨率、时长、帧率、平台、字幕、音频、安全区、变体）。保存后重新打开会精确回显。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DeliverySpecForm
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
              data-test="ds-save"
            >
              保存交付规格
            </Button>
          </div>
        )}
        {!canUpdate && (
          <p className="text-xs text-ml2-text-3" data-test="ds-readonly-note">
            你只有只读权限，无法编辑交付规格。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
