import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { capabilityClient } from '@/services/client-capabilities';
import {
  ArrowLeft,
  Heart,
  Download,
  Trash2,
  Share2,
  Eye,
  EyeOff,
  Check,
  Crop,
  Eraser,
  Wand2,
  Palette,
  ZoomIn,
  Undo2,
  Redo2,
  ChevronDown,
  Sparkles,
  Plus,
  Search,
  Settings2,
} from 'lucide-react';
import Image from '@/components/ui/image';
import { IMediaItem, MOCK_MEDIA_LIST } from '@/data/media';
import { useModelHub } from '@/hooks/useModelHub';
import { getEffectiveModelName } from '@/data/models';
import { apiGetMedia, apiSaveMedia, ensureApi, stripBlobItems } from '@/services/api';

export default function ImageEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [mediaList, setMediaList] = useState<IMediaItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(id ?? null);
  const [showHistory, setShowHistory] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [editing, setEditing] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [model, setModel] = useState('Nano Banana 2 Lite');
  const [modelSearch, setModelSearch] = useState('');
  const { providers, models } = useModelHub();

  const tools = [
    { key: 'crop', icon: Crop, label: '裁剪' },
    { key: 'erase', icon: Eraser, label: '擦除' },
    { key: 'expand', icon: ZoomIn, label: '扩图' },
    { key: 'style', icon: Palette, label: '风格' },
    { key: 'redraw', icon: Wand2, label: '重绘' },
  ];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list: IMediaItem[] = [];
      const ok = await ensureApi();
      if (ok) {
        try { list = await apiGetMedia(); } catch { list = []; }
      }
      const validItems = stripBlobItems(list); // 过滤 blob 临时项
      const finalList = validItems.length > 0 ? validItems : MOCK_MEDIA_LIST;
      if (cancelled) return;
      setMediaList(finalList);
      // 空数据时把 MOCK 写回后端，保证所有设备一致
      if (ok && validItems.length === 0) { try { apiSaveMedia(stripBlobItems(finalList)); } catch {} }
    })();
    return () => { cancelled = true; };
  }, []);

  // 持久化（写回后端 API）
  useEffect(() => {
    if (mediaList.length === 0) return;
    apiSaveMedia(stripBlobItems(mediaList));
  }, [mediaList]);

  const currentItem = useMemo(
    () => mediaList.find((m) => m.id === currentId) ?? null,
    [mediaList, currentId],
  );

  // 历史版本：取同类型的前5张作为模拟历史
  const historyVersions = useMemo(() => {
    if (!currentItem) return [];
    return mediaList
      .filter((m) => m.type === currentItem.type && !m.isDeleted)
      .slice(0, 6);
  }, [mediaList, currentItem]);

  const handleEdit = async () => {
    if (!prompt.trim() || !currentItem || editing) return;
    setEditing(true);
    try {
      const result = await capabilityClient
        .load('ai-image-edit')
        .call('imageToImage', {
          prompt: prompt,
          referenceImages: [currentItem.fullUrl],
        });
      const images = (result as { images?: string[] })?.images ?? [];
      if (images.length > 0) {
        const newItem: IMediaItem = {
          id: `edit-${Date.now()}`,
          title: `${currentItem.title} (编辑)`,
          type: 'image',
          thumbnail: images[0],
          fullUrl: images[0],
          prompt: prompt,
          model: model,
          ratio: currentItem.ratio,
          createdAt: new Date().toISOString(),
          isFavorite: false,
          isDeleted: false,
          source: 'user',
        };
        setMediaList((prev) => [newItem, ...prev]);
        setCurrentId(newItem.id);
        setPrompt('');
        toast.success('编辑成功');
      } else {
        toast.error('编辑服务暂不可用');
      }
    } catch {
      toast.error('编辑服务暂不可用');
    } finally {
      setEditing(false);
    }
  };

  const handleToggleFavorite = () => {
    if (!currentId) return;
    setMediaList((prev) =>
      prev.map((m) => (m.id === currentId ? { ...m, isFavorite: !m.isFavorite } : m)),
    );
  };

  const handleDelete = () => {
    if (!currentId) return;
    setMediaList((prev) => prev.map((m) => (m.id === currentId ? { ...m, isDeleted: true } : m)));
    navigate(-1);
  };

  if (!currentItem) {
    return (
      <div className="flex h-full items-center justify-center bg-black text-zinc-500">
        加载中...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-black text-white">
      {/* 顶部栏 */}
      <header className="flex h-14 items-center justify-between px-4 border-b border-zinc-800 bg-black/80 backdrop-blur-md z-20 sticky top-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
          >
            <ArrowLeft className="size-4" />
          </button>
          <div className="flex items-center gap-1 text-sm">
            <span className="text-zinc-400">1 / {historyVersions.length}</span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={handleToggleFavorite}
            className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
              currentItem.isFavorite
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
            }`}
          >
            <Heart className={`size-4 ${currentItem.isFavorite ? 'fill-current' : ''}`} />
          </button>
          <button className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors">
            <Download className="size-4" />
          </button>
          <button
            onClick={handleDelete}
            className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
          >
            <Trash2 className="size-4" />
          </button>
          <button className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors">
            <Share2 className="size-4" />
          </button>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
            title={showHistory ? '隐藏历史' : '显示历史'}
          >
            {showHistory ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
          </button>
          <button className="ml-2 flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-bold text-black hover:bg-emerald-400 transition-colors">
            <Check className="size-4" />
            完成
          </button>
        </div>
      </header>

      {/* 历史版本缩略图横条 */}
      {showHistory && (
        <div className="flex items-center gap-2 overflow-x-auto border-b border-zinc-800 px-4 py-3">
          {historyVersions.map((v, i) => (
            <button
              key={v.id}
              onClick={() => setCurrentId(v.id)}
              className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border-2 transition-all duration-300 ${
                v.id === currentId
                  ? 'border-emerald-500 ring-2 ring-emerald-500/30'
                  : 'border-zinc-800 hover:border-zinc-700'
              }`}
            >
              <Image src={v.thumbnail} alt="" className="h-full w-full object-cover" />
              <span className="absolute bottom-0.5 right-1 text-[9px] font-bold text-white/80">
                v{i + 1}
              </span>
            </button>
          ))}
          <button className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-dashed border-zinc-700 text-zinc-500 hover:border-emerald-500/50 hover:text-emerald-400 transition-colors">
            <Plus className="size-5" />
          </button>
        </div>
      )}

      {/* 主编辑区 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧工具栏 */}
        <div className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-zinc-800 py-3">
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <button
                key={tool.key}
                onClick={() => setActiveTool(activeTool === tool.key ? null : tool.key)}
                className={`flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-2xl transition-all duration-300 ${
                  activeTool === tool.key
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                    : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white border border-transparent'
                }`}
                title={tool.label}
              >
                <Icon className="size-4" />
              </button>
            );
          })}
          <div className="my-2 h-px w-8 bg-zinc-800" />
          <button className="flex h-11 w-11 items-center justify-center rounded-2xl text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors">
            <Undo2 className="size-4" />
          </button>
          <button className="flex h-11 w-11 items-center justify-center rounded-2xl text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors">
            <Redo2 className="size-4" />
          </button>
        </div>

        {/* 中央大图预览 */}
        <div className="flex flex-1 items-center justify-center p-8 overflow-auto bg-[radial-gradient(circle_at_center,_hsl(240_4%_16%)_1px,_transparent_1px)] bg-[length:24px_24px]">
          <div className="relative max-h-full max-w-full rounded-[2rem] overflow-hidden shadow-2xl border border-zinc-800">
            <Image
              src={currentItem.fullUrl}
              alt={currentItem.title}
              className="max-h-[70vh] max-w-full object-contain"
            />
            {/* 翡翠光晕装饰 */}
            <div className="pointer-events-none absolute -top-20 -right-20 h-40 w-40 bg-emerald-500/10 blur-[80px] rounded-full" />
          </div>
        </div>
      </div>

      {/* 底部编辑输入栏 */}
      <div className="border-t border-zinc-800 px-4 py-3 bg-black">
        <div className="mx-auto max-w-3xl rounded-[2rem] bg-zinc-900/90 backdrop-blur-xl border border-zinc-800">
          <div className="flex items-center gap-2 px-4 py-3">
            <button className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-800/50 text-emerald-400 hover:bg-zinc-800 transition-colors">
              <Sparkles className="size-4" />
            </button>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述你想要的修改效果..."
              className="flex-1 bg-transparent py-2 text-sm text-white placeholder:text-zinc-600 focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleEdit();
              }}
            />
            <div className="relative">
              <button
                onClick={() => setModelMenuOpen(!modelMenuOpen)}
                className="flex items-center gap-1.5 rounded-full bg-zinc-800/50 px-3 py-2 text-xs text-white hover:bg-zinc-800 transition-colors"
              >
                <div className="flex flex-col items-start leading-tight">
                  <span className="max-w-[100px] truncate font-medium">{getEffectiveModelName(models.find((m) => m.displayName === model)) || model}</span>
                  <span className="text-[9px] text-zinc-500">
                    {providers.find((p) => p.id === models.find((m) => m.displayName === model)?.providerId)?.name || '未知'}
                  </span>
                </div>
                <ChevronDown className="size-3 text-zinc-500" />
              </button>
              {modelMenuOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => { setModelMenuOpen(false); setModelSearch(''); }} />
                  <div className="absolute right-0 bottom-full z-40 mb-1 w-64 overflow-hidden rounded-2xl bg-zinc-900 border border-zinc-800">
                    <div className="border-b border-zinc-800 p-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
                        <input
                          type="text"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          placeholder="搜索模型..."
                          autoFocus
                          className="w-full rounded-xl bg-zinc-800/50 pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors"
                        />
                      </div>
                    </div>
                    <div className="max-h-64 overflow-y-auto p-1.5">
                      {(() => {
                        const filtered = models.filter((m) => {
                          const p = providers.find((x) => x.id === m.providerId);
                          if (!p || !p.enabled || !m.enabled) return false;
                          if (m.type !== 'image') return false;
                          if (modelSearch && !m.displayName.toLowerCase().includes(modelSearch.toLowerCase()) && !getEffectiveModelName(m).toLowerCase().includes(modelSearch.toLowerCase())) return false;
                          return true;
                        });
                        const byProvider = filtered.reduce((acc, m) => {
                          if (!acc[m.providerId]) acc[m.providerId] = [];
                          acc[m.providerId].push(m);
                          return acc;
                        }, {} as Record<string, typeof models>);
                        if (Object.keys(byProvider).length === 0) {
                          return <div className="py-4 text-center text-xs text-zinc-600">暂无可用模型</div>;
                        }
                        return Object.entries(byProvider).map(([pid, list]) => (
                          <div key={pid} className="mb-1.5 last:mb-0">
                            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                              {providers.find((p) => p.id === pid)?.name || '未知'}
                            </div>
                            {list.map((m) => (
                              <button
                                key={m.id}
                                onClick={() => {
                                  setModel(m.displayName);
                                  setModelMenuOpen(false);
                                  setModelSearch('');
                                }}
                                className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition-all duration-200 ${
                                  model === m.displayName
                                    ? 'bg-emerald-500/10 text-emerald-400 font-medium'
                                    : 'text-zinc-300 hover:bg-zinc-800/50'
                                }`}
                              >
                                <span className="flex-1 truncate">{getEffectiveModelName(m) || m.displayName}</span>
                              </button>
                            ))}
                          </div>
                        ));
                      })()}
                    </div>
                    {/* 底部：模型Hub入口 */}
                    <div className="border-t border-zinc-800 p-1.5">
                      <button
                        onClick={() => {
                          setModelMenuOpen(false);
                          setModelSearch('');
                          navigate('/model-hub');
                        }}
                        className="flex w-full items-center justify-center gap-1.5 rounded-xl py-1.5 text-[10px] font-semibold text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-colors"
                      >
                        <Settings2 className="size-3" />
                        管理模型 (模型 Hub)
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
            <button
              onClick={handleEdit}
              disabled={editing || !prompt.trim()}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-40 transition-colors"
            >
              {editing ? (
                <div className="size-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />
              ) : (
                <Sparkles className="size-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
