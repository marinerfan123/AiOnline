// 模型级参数模板编辑器（管理员后台「管理模型」抽屉内使用）
// 后台简单自定义：质量 / 比例 / 分辨率档位 / 视频时长 / 数量开关 / 参考图 / 规则说明。
// 前台 GenerationBar 读取模型 paramTemplate 后按类型渲染对应设置 UI。
import { useState } from 'react';
import { type Ratio, type Quality } from '@/data/settings';
import { ALL_RESOLUTIONS, type Resolution, type IModelParamTemplate, type ModelType } from '@/data/models';

const ALL_QUALITIES: Quality[] = ['low', 'standard', 'high'];
const QUALITY_LABEL: Record<Quality, string> = { low: '低画质', standard: '标准画质', high: '高画质' };
// 比例预设（与 GenerationBar 的 ALL_RATIOS 保持一致）
const RATIO_PRESET: Ratio[] = [
  'auto', '1:1', '1:2', '2:1',
  '9:16', '16:9', '3:4', '4:3',
  '3:2', '2:3', '5:4', '4:5',
  '21:9', '9:21',
];
const DURATIONS: (4 | 6 | 8 | 10)[] = [4, 6, 8, 10];
const VIDEO_RES: ('1k' | '2k' | '3k' | '4k')[] = ['1k', '2k', '3k', '4k'];

function Pill({
  active, label, onClick, title,
}: { active: boolean; label: string; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded-full px-2 py-0.5 text-[10px] font-bold border transition-colors ${
        active
          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
          : 'bg-zinc-800/50 text-zinc-500 border-zinc-700 hover:border-zinc-600 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pt-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{title}</div>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

function toggleIn<T>(arr: T[] | undefined, v: T): T[] {
  const set = new Set(arr || []);
  if (set.has(v)) set.delete(v); else set.add(v);
  return Array.from(set);
}

export interface ModelParamTemplateEditorProps {
  modelType: ModelType;
  value: IModelParamTemplate;
  onChange: (tpl: IModelParamTemplate) => void;
}

export function ModelParamTemplateEditor({ modelType, value, onChange }: ModelParamTemplateEditorProps) {
  const isVideo = modelType === 'video';
  const [rulesText, setRulesText] = useState(
    (value.rules || []).map((r) => `${r.label}|${r.description}`).join('\n'),
  );

  const set = (patch: Partial<IModelParamTemplate>) => onChange({ ...value, ...patch });

  const parseRules = (text: string): void => {
    setRulesText(text);
    const rules = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf('|');
        if (idx < 0) return { label: line.slice(0, 12), description: line };
        return { label: line.slice(0, idx).trim(), description: line.slice(idx + 1).trim() };
      });
    set({ rules });
  };

  return (
    <div className="mt-2 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-2.5 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-indigo-300">参数模板（前台按类型渲染）</span>
        <button
          type="button"
          onClick={() => onChange({})}
          className="rounded-full bg-zinc-800/60 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-white transition-colors"
          title="清空后前台按模型类型用系统默认"
        >
          重置为默认
        </button>
      </div>

      {/* 质量 */}
      <Section title="质量档位">
        {ALL_QUALITIES.map((q) => (
          <Pill
            key={q}
            active={(value.qualities || []).includes(q)}
            label={QUALITY_LABEL[q]}
            onClick={() => set({ qualities: toggleIn(value.qualities, q) as Quality[] })}
          />
        ))}
      </Section>

      {/* 比例 */}
      <Section title="比例档位">
        {RATIO_PRESET.map((r) => (
          <Pill
            key={r}
            active={(value.ratios || []).includes(r)}
            label={r === 'auto' ? '智能' : r}
            onClick={() => set({ ratios: toggleIn(value.ratios as string[] | undefined, r) as string[] })}
          />
        ))}
      </Section>

      {/* 图片分辨率 */}
      {!isVideo && (
        <Section title="图片分辨率">
          {ALL_RESOLUTIONS.map((res) => (
            <Pill
              key={res}
              active={(value.resolutions || []).includes(res)}
              label={res}
              onClick={() => set({ resolutions: toggleIn(value.resolutions, res) as Resolution[] })}
            />
          ))}
        </Section>
      )}

      {/* 视频时长 + 分辨率档位 */}
      {isVideo && (
        <>
          <Section title="视频时长">
            {DURATIONS.map((d) => (
              <Pill
                key={d}
                active={(value.durations || []).includes(d)}
                label={`${d}s`}
                onClick={() => set({ durations: toggleIn(value.durations, d) as (4 | 6 | 8 | 10)[] })}
              />
            ))}
          </Section>
          <Section title="分辨率档位开关">
            <Pill
              active={!!value.videoResolutionsEnabled}
              label={value.videoResolutionsEnabled ? '已开启 1K/2K/3K/4K' : '未开启'}
              onClick={() => set({ videoResolutionsEnabled: !value.videoResolutionsEnabled })}
              title="开启后前台显示分辨率档位，默认智能用 1K"
            />
            {value.videoResolutionsEnabled && (
              <span className="ml-1 flex flex-wrap items-center gap-1">
                {VIDEO_RES.map((res) => (
                  <Pill
                    key={res}
                    active={(value.videoResolutions || []).includes(res)}
                    label={res}
                    onClick={() => set({ videoResolutions: toggleIn(value.videoResolutions, res) as ('1k' | '2k' | '3k' | '4k')[] })}
                  />
                ))}
              </span>
            )}
          </Section>
        </>
      )}

      {/* 数量开关（图片）/ 视频固定 1 */}
      <Section title="数量">
        {isVideo ? (
          <span className="text-[10px] text-amber-400">视频固定 1 个，不支持批量</span>
        ) : (
          <Pill
            active={value.allowCount !== false}
            label={value.allowCount !== false ? '允许批量(1-4)' : '固定 1 张'}
            onClick={() => set({ allowCount: value.allowCount === false ? true : false })}
          />
        )}
      </Section>

      {/* 参考图 / 反向提示词 */}
      <Section title="能力">
        <Pill
          active={value.supportsReference !== false}
          label="参考图"
          onClick={() => set({ supportsReference: value.supportsReference === false ? true : false })}
          title="图生图 / 视频首帧"
        />
        <Pill
          active={value.supportsNegative !== false}
          label="反向提示词"
          onClick={() => set({ supportsNegative: value.supportsNegative === false ? true : false })}
        />
      </Section>

      {/* 规则说明 */}
      <div className="pt-2">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          规则说明（每行一条：短标签|说明）
        </div>
        <textarea
          value={rulesText}
          onChange={(e) => parseRules(e.target.value)}
          rows={2}
          placeholder={'数量固定|视频每次生成 1 个\n分辨率档位|后台开启后可选，默认智能 1K'}
          className="w-full resize-none rounded-lg bg-zinc-800/40 px-2 py-1 text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:bg-zinc-800/70"
        />
      </div>
    </div>
  );
}
