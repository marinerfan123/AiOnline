// ── W1-11 — Shot Inspector core UI ───────────────────────────────────────────
// Reads the authoritative Shot (from the shots API), lets the user edit the CORE
// fields (title / storyIntent / cinematography / context / durationSeconds /
// seq / note), and persists via PATCH with the OPTIMISTIC `version` the server
// last returned.
//
// TRUTH RULE: there is NO local-only hidden state for the core fields. The
// editable values and the `version` token always come from the refetched server
// shot (TanStack Query). On success the query is invalidated → refetch → exact
// echo. On 409 STALE_SHOT_VERSION the query is invalidated (→ server truth) and
// the user is prompted to re-review. generationMeta / output / commerce are
// LOCKED_FIELD — shown read-only (system-owned), never editable, never sent.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/shared/ui/v2/Button';
import { Input, Textarea } from '@/shared/ui/v2/Input';
import { LoadingState, ErrorState, EmptyState } from '@/shared/ui/v2/states';
import {
  studioShotInspectorClient,
  ShotInspectorApiError,
  type Shot,
  type ShotUpdateBody,
} from '@/shared/api/contract/studio-shot-inspector-client';
import {
  LOCKED_FIELDS,
  buildShotPatch,
  shotToDraft,
  validateShotDraft,
  draftDiffersFromShot,
  type ShotDraft,
  type ShotFormErrors,
} from './shotDraft';

interface ShotInspectorProps {
  projectId: string;
  episodeId: string;
  shotId: string;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-ml2-border px-3 py-2.5">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ml2-text-3">{title}</h3>
      {children}
    </div>
  );
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-[11px] font-medium text-ml2-text-2">
      {children}
      {required && <span className="ml-1 text-red-400">*</span>}
    </label>
  );
}

function fieldError(errors: ShotFormErrors | null, key: string) {
  return errors?.fields[key];
}

export function ShotInspector({ projectId, episodeId, shotId }: ShotInspectorProps) {
  const qc = useQueryClient();
  const queryKey = ['v2', 'studio', projectId, episodeId, 'shots'] as const;
  const [draft, setDraft] = useState<ShotDraft>(shotToDraft(null));
  const [errors, setErrors] = useState<ShotFormErrors | null>(null);
  const [serverNotice, setServerNotice] = useState<string | null>(null);

  const shotsQuery = useQuery({
    queryKey,
    queryFn: () => studioShotInspectorClient.list(projectId, episodeId),
    staleTime: 30_000,
    retry: 0,
  });

  const shot: Shot | null = useMemo(
    () => shotsQuery.data?.shots.find((s) => s.id === shotId) ?? null,
    [shotsQuery.data, shotId],
  );

  // ── TRUTH RULE ──
  // Re-seed the draft and reset transient validation state whenever the server-authoritative
  // shot changes identity OR its version changes (i.e. every time server truth
  // moves — first load, post-save refetch, post-409 refetch). The `version` used
  // for PATCH is read straight from `shot.version` below; it is never a hidden
  // local counter.
  useEffect(() => {
    setDraft(shotToDraft(shot));
    setErrors(null);
  }, [shotId, shot?.version]);

  // Transient server notice (409 stale / 400 locked) survives a version-change
  // refetch (which re-seeds the draft) and is cleared only when switching shots.
  useEffect(() => {
    setServerNotice(null);
  }, [shotId]);

  const save = useMutation({
    mutationFn: (body: ShotUpdateBody) => studioShotInspectorClient.update(projectId, episodeId, shotId, body),
    onSuccess: () => {
      setErrors(null);
      setServerNotice(null);
      toast.success('镜头已保存');
      // Refetch so the inspector echoes EXACTLY what the server persisted (server truth).
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e) => {
      if (e instanceof ShotInspectorApiError) {
        if (e.status === 409) {
          // STALE_SHOT_VERSION → refetch server truth + prompt the user.
          setErrors(null);
          setServerNotice('镜头已被其他用户更新，已重新加载最新数据。请检查后再次保存。');
          void qc.invalidateQueries({ queryKey });
          return;
        }
        if (e.status === 400) {
          const body = (e.details ?? {}) as { error?: string; field?: string };
          if (body.error === 'LOCKED_FIELD') {
            setServerNotice(`字段 ${body.field ?? ''} 由系统锁定，只读展示（生成结果 / 输出 / 商业数据）。`);
          } else {
            setErrors({ fields: {}, global: [body.error ?? e.message] });
          }
          return;
        }
      }
      toast.error(e instanceof Error ? e.message : '保存镜头失败');
    },
  });

  const handleSave = () => {
    setServerNotice(null);
    const result = validateShotDraft(draft);
    if (!result.ok) {
      setErrors(result.errors ?? { fields: {}, global: [] });
      return;
    }
    if (!shot) {
      setErrors({ fields: {}, global: ['镜头不存在或已删除，无法保存。'] });
      return;
    }
    // Optimistic concurrency: token = the server-authoritative version, never local.
    save.mutate(buildShotPatch(draft, shot.version));
  };

  if (shotsQuery.isLoading) {
    return (
      <div data-test="shot-inspector">
        <Section title="Shot Inspector">
          <LoadingState label="加载镜头…" />
        </Section>
      </div>
    );
  }

  if (shotsQuery.isError) {
    return (
      <div data-test="shot-inspector">
        <Section title="Shot Inspector">
          <ErrorState
            title="无法加载镜头"
            description={(shotsQuery.error as Error).message}
            onRetry={() => shotsQuery.refetch()}
          />
        </Section>
      </div>
    );
  }

  if (!shot) {
    return (
      <div data-test="shot-inspector">
        <Section title="Shot Inspector">
          <EmptyState title="镜头不存在" description="请先在 Shots 时间线中选择一个镜头。" />
        </Section>
      </div>
    );
  }

  const dirty = draftDiffersFromShot(draft, shot);
  const disabled = save.isPending;

  return (
    <div data-test="shot-inspector" className="space-y-0">
      <Section title="Shot Inspector">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded bg-ml2-surface-3 text-[11px] font-semibold text-ml2-accent">
            #{shot.seq}
          </span>
          <div className="min-w-0 flex-1">
            <Input
              data-test="shot-title"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              aria-invalid={Boolean(fieldError(errors, 'title'))}
              className="h-6 px-1.5 text-[11px]"
              placeholder="镜头标题"
            />
            <p className="mt-1 text-[10px] text-ml2-text-3">
              seq #{shot.seq} · server v{shot.version}
            </p>
          </div>
        </div>
        {fieldError(errors, 'title') && <p className="mt-1 text-[10px] text-red-400">{fieldError(errors, 'title')}</p>}
      </Section>

      {/* LOCKED_FIELDS — system-owned, read-only display (never editable / never sent). */}
      <Section title="Locked (system-owned)">
        <div className="space-y-2">
          {LOCKED_FIELDS.map(({ key, label }) => {
            const value = shot[key as keyof Shot];
            return (
              <div key={key}>
                <FieldLabel>{label}</FieldLabel>
                <pre
                  data-test={`shot-locked-${key}`}
                  className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ml2-surface-3 p-2 text-[10px] leading-snug text-ml2-text-3"
                >
                  {value == null ? '—' : JSON.stringify(value, null, 2)}
                </pre>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="核心字段 Core">
        <div className="space-y-3">
          <div>
            <FieldLabel required>序号 seq</FieldLabel>
            <Input
              data-test="shot-seq"
              type="number"
              value={draft.seq}
              onChange={(e) => setDraft((d) => ({ ...d, seq: e.target.value }))}
              aria-invalid={Boolean(fieldError(errors, 'seq'))}
              className="h-8 text-xs"
            />
            {fieldError(errors, 'seq') && <p className="mt-1 text-[10px] text-red-400">{fieldError(errors, 'seq')}</p>}
          </div>

          <div>
            <FieldLabel>时长 duration (s)</FieldLabel>
            <Input
              data-test="shot-duration"
              type="number"
              value={draft.durationSeconds}
              onChange={(e) => setDraft((d) => ({ ...d, durationSeconds: e.target.value }))}
              aria-invalid={Boolean(fieldError(errors, 'durationSeconds'))}
              className="h-8 text-xs"
            />
            {fieldError(errors, 'durationSeconds') && (
              <p className="mt-1 text-[10px] text-red-400">{fieldError(errors, 'durationSeconds')}</p>
            )}
          </div>

          <div>
            <FieldLabel>备注 note</FieldLabel>
            <Textarea
              data-test="shot-note"
              value={draft.note}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              aria-invalid={Boolean(fieldError(errors, 'note'))}
              rows={3}
              className="text-[11px]"
            />
            {fieldError(errors, 'note') && <p className="mt-1 text-[10px] text-red-400">{fieldError(errors, 'note')}</p>}
          </div>

          <div>
            <FieldLabel required>剧情意图 storyIntent (JSON)</FieldLabel>
            <Textarea
              data-test="shot-story-intent"
              value={draft.storyIntent}
              onChange={(e) => setDraft((d) => ({ ...d, storyIntent: e.target.value }))}
              aria-invalid={Boolean(fieldError(errors, 'storyIntent'))}
              rows={4}
              className="font-mono text-[11px]"
            />
            {fieldError(errors, 'storyIntent') && (
              <p className="mt-1 text-[10px] text-red-400">{fieldError(errors, 'storyIntent')}</p>
            )}
          </div>

          <div>
            <FieldLabel>运镜 cinematography</FieldLabel>
            <Textarea
              data-test="shot-cinematography"
              value={draft.cinematography}
              onChange={(e) => setDraft((d) => ({ ...d, cinematography: e.target.value }))}
              rows={3}
              className="text-[11px]"
            />
          </div>

          <div>
            <FieldLabel>上下文 context</FieldLabel>
            <Textarea
              data-test="shot-context"
              value={draft.context}
              onChange={(e) => setDraft((d) => ({ ...d, context: e.target.value }))}
              rows={3}
              className="text-[11px]"
            />
          </div>
        </div>
      </Section>

      {serverNotice && (
        <div data-test="shot-server-notice" className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400">
          {serverNotice}
        </div>
      )}
      {errors?.global?.length ? (
        <div data-test="shot-global-errors" className="space-y-1 border-b border-red-500/30 px-3 py-2 text-[11px] text-red-400">
          {errors.global.map((m) => <p key={m}>{m}</p>)}
        </div>
      ) : null}

      <Section title="Actions">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-ml2-text-3">{dirty ? '有未保存更改' : '已同步'}</span>
          <Button
            size="sm"
            data-test="shot-save"
            loading={save.isPending}
            disabled={disabled || !dirty && !save.isPending}
            onClick={handleSave}
          >
            保存镜头
          </Button>
        </div>
      </Section>
    </div>
  );
}
