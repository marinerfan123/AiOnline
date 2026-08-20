import { useEffect, useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ImageOff, ArrowLeft, Loader2 } from 'lucide-react';
import { apiGetUser, apiGetUserMedia } from '@/services/api';
import { useAuth } from '@/services/authStore';
import ImageViewer from '@/components/ImageViewer';
import type { IMediaItem } from '@/data/media';

interface PubUser { id: string; displayName: string; createdAt: string; }
interface PubMedia { id: string; title: string; thumbnail: string; fullUrl: string; type: string; category: string; }

export default function UserPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [profile, setProfile] = useState<PubUser | null>(null);
  const [media, setMedia] = useState<PubMedia[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  const viewerItems = useMemo<IMediaItem[]>(
    () =>
      media.map((m) => ({
        id: m.id,
        title: m.title,
        fullUrl: m.fullUrl,
        thumbnail: m.thumbnail,
        type: (m.type === 'video' ? 'video' : 'image') as 'image' | 'video',
        model: '',
        ratio: '',
        createdAt: '',
        prompt: '',
        isFavorite: false,
        isDeleted: false,
        source: 'user' as const,
      })),
    [media],
  );

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    setNotFound(false);
    (async () => {
      try {
        const [u, m] = await Promise.all([apiGetUser(id), apiGetUserMedia(id)]);
        if (!alive) return;
        setProfile(u.user);
        setMedia(m.items || []);
      } catch {
        if (alive) setNotFound(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (notFound || !profile) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
        <ImageOff className="size-8" />
        <p>该创作者不存在或已被注销</p>
        <Link to="/" className="flex items-center gap-1.5 text-emerald-400 hover:underline">
          <ArrowLeft className="size-3.5" /> 返回首页
        </Link>
      </div>
    );
  }

  const isSelf = user?.id === profile.id;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        {/* 头部 */}
        <div className="mb-8 flex items-center gap-4">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-400 text-2xl font-bold text-black">
            {(profile.displayName || 'U')[0]?.toUpperCase() || 'U'}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-white">{profile.displayName}</h1>
              {isSelf && (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">我</span>
              )}
            </div>
            <p className="text-xs text-zinc-500">
              加入于 {new Date(profile.createdAt).toLocaleDateString('zh-CN')} · {media.length} 个公开作品
            </p>
          </div>
          {isSelf && (
            <Link
              to="/account"
              className="rounded-xl border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors"
            >
              账户设置
            </Link>
          )}
        </div>

        {/* 作品墙 */}
        {media.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-zinc-800 py-16 text-zinc-600">
            <ImageOff className="size-7" />
            <p className="text-sm">还没有公开作品</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {media.map((m, index) => (
              <button
                key={m.id}
                type="button"
                onDoubleClick={() => {
                  setViewerIndex(index);
                  setViewerOpen(true);
                }}
                className="group relative aspect-[4/5] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/50 text-left transition-all duration-300 hover:border-emerald-500/40 hover:shadow-xl hover:shadow-black/40 cursor-zoom-in"
              >
                <img
                  src={m.thumbnail}
                  alt={m.title}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0.2'; }}
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                  <p className="truncate text-xs font-medium text-white">{m.title || '未命名作品'}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 图片放大查看器 */}
      {viewerOpen && (
        <ImageViewer
          items={viewerItems}
          currentIndex={viewerIndex}
          onClose={() => setViewerOpen(false)}
          onIndexChange={setViewerIndex}
        />
      )}
    </div>
  );
}
