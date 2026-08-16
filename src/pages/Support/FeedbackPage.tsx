import { useState } from 'react';
import { MessageSquareWarning, Send, CheckCircle, Loader2 } from 'lucide-react';
import { SupportLayout, SupportCard } from './SupportLayout';
import { apiSubmitFeedback } from '@/services/api';

const types = [
  { key: 'bug', label: 'Bug 反馈' },
  { key: 'feature', label: '功能建议' },
  { key: 'consult', label: '使用咨询' },
  { key: 'other', label: '其他' },
];

export default function FeedbackPage() {
  const [type, setType] = useState('bug');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [loading, setLoading] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await apiSubmitFeedback({ type, title: title.trim(), content: content.trim(), contact: contact.trim() });
      if (r.ok) {
        setOk(true);
        setType('bug');
        setTitle('');
        setContent('');
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
    <SupportLayout title="发送应用反馈" subtitle="遇到 Bug 或有新想法？告诉我们">
      <SupportCard>
        {ok ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle className="size-10 text-emerald-400" />
            <h3 className="text-base font-semibold text-white">反馈已提交</h3>
            <p className="text-sm text-zinc-400">感谢你的反馈，我们会尽快处理。</p>
            <button
              onClick={() => setOk(false)}
              className="mt-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
            >
              再写一条
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs text-zinc-500">反馈类型</label>
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
              <label className="mb-1.5 block text-xs text-zinc-500">标题</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                placeholder="一句话概括你的反馈"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-zinc-500">详细描述</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                required
                rows={6}
                placeholder="请尽可能详细地描述问题或建议，包括复现步骤、期望结果等。"
                className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-zinc-500">联系方式（选填）</label>
              <input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="邮箱 / 手机号，方便我们跟进"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
              />
            </div>

            {err && <p className="text-xs text-red-400">{err}</p>}

            <button
              type="submit"
              disabled={loading || !title.trim() || !content.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 py-2.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:opacity-40"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              提交反馈
            </button>
          </form>
        )}
      </SupportCard>
    </SupportLayout>
  );
}
