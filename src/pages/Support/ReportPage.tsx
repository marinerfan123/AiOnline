import { useState } from 'react';
import { Flag, Send, CheckCircle, Loader2 } from 'lucide-react';
import { SupportLayout, SupportCard } from './SupportLayout';
import { apiSubmitReport } from '@/services/api';

const types = [
  { key: 'infringement', label: '侵权 / 盗用' },
  { key: 'illegal', label: '违法违规' },
  { key: 'porn', label: '色情 / 低俗' },
  { key: 'other', label: '其他' },
];

export default function ReportPage() {
  const [type, setType] = useState('infringement');
  const [targetUrl, setTargetUrl] = useState('');
  const [content, setContent] = useState('');
  const [evidence, setEvidence] = useState('');
  const [contact, setContact] = useState('');
  const [loading, setLoading] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await apiSubmitReport({
        type,
        targetUrl: targetUrl.trim(),
        content: content.trim(),
        evidence: evidence.trim(),
        contact: contact.trim(),
      });
      if (r.ok) {
        setOk(true);
        setType('infringement');
        setTargetUrl('');
        setContent('');
        setEvidence('');
        setContact('');
      } else {
        setErr(r.error || '提交失败');
      }
    } catch (e: any) {
      setErr(e?.message || '提交失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SupportLayout title="举报法律问题" subtitle="侵权、违法或其他违规内容举报">
      <SupportCard>
        {ok ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle className="size-10 text-emerald-400" />
            <h3 className="text-base font-semibold text-white">举报已收到</h3>
            <p className="text-sm text-zinc-400">我们会尽快核实并处理，必要时会与你联系。</p>
            <button
              onClick={() => setOk(false)}
              className="mt-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
            >
              继续举报
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs text-zinc-500">举报类型</label>
              <div className="flex flex-wrap gap-2">
                {types.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setType(t.key)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      type === t.key
                        ? 'bg-emerald-500 text-black'
                        : 'border border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:border-zinc-600 hover:text-white'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-zinc-500">被举报内容链接 / ID（选填）</label>
              <input
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="例如：https://moling.ai/user/xxx 或 素材 ID"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-zinc-500">举报描述</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                required
                rows={5}
                placeholder="请描述违规情况，包括涉及的权利、法律依据等。"
                className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-zinc-500">证据材料（选填）</label>
              <textarea
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                rows={3}
                placeholder="可补充截图链接、权属证明、联系方式等。"
                className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-zinc-500">你的联系方式（选填）</label>
              <input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="邮箱 / 手机号"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>

            {err && <p className="text-xs text-red-400">{err}</p>}

            <button
              type="submit"
              disabled={loading || !content.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 py-2.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:opacity-40"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              提交举报
            </button>
          </form>
        )}
      </SupportCard>
    </SupportLayout>
  );
}
