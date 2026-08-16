import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  User,
  Trash2,
  Edit3,
  Download,
  Sparkles,
  Image as ImageIcon,
  Check,
  X,
  Star,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import TopBar from '@/components/TopBar';
import Image from '@/components/ui/image';
import { ICharacter, ICharacterStats, MOCK_CHARACTERS } from '@/data/characters';
import {
  apiGetCharacters,
  apiSaveCharacters,
  apiDeleteCharacter,
  apiGetCharacterStats,
  ensureApi,
} from '@/services/api';
import { useOssConfig } from '@/hooks/useOssConfig';

export default function CharactersPage() {
  const navigate = useNavigate();
  const { enabled: ossEnabled, ingestFile } = useOssConfig();

  const [characters, setCharacters] = useState<ICharacter[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newRefImage, setNewRefImage] = useState('');
  const [creating, setCreating] = useState(false);

  // 行内编辑
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  // 删除确认弹窗
  const [deleteTarget, setDeleteTarget] = useState<ICharacter | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 统计（实时聚合，杜绝写死数字）
  const [statsMap, setStatsMap] = useState<Record<string, ICharacterStats>>({});
  const [statsLoading, setStatsLoading] = useState(false);

  // 上传中
  const uploadRef = useRef<HTMLInputElement>(null);
  const createUploadRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list: ICharacter[] = [];
      const ok = await ensureApi();
      if (ok) {
        try { list = await apiGetCharacters(); } catch { list = []; }
      }
      // 防御：list 必须为真数组，否则回退 MOCK，杜绝后续 .map 崩溃
      if (!Array.isArray(list)) list = [];
      const final = list.length > 0 ? list : MOCK_CHARACTERS;
      if (cancelled) return;
      setCharacters(final);
      // 空数据时把 MOCK 写回后端，保证所有设备一致
      if (ok && list.length === 0) { try { apiSaveCharacters(final); } catch {} }
      if (final.length > 0) setSelectedId(final[0].id);
    })();
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(
    () => characters.find((c) => c.id === selectedId) ?? null,
    [characters, selectedId],
  );

  // 选中角色变化时，拉取真实生成统计
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setStatsLoading(true);
    (async () => {
      const stats = await apiGetCharacterStats(selected.id);
      if (cancelled) return;
      setStatsMap((m) => ({ ...m, [selected.id]: stats }));
      setStatsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selected?.id]);

  // ── 持久化整个角色库（编辑/上传/删除参考图/设头像）──
  const persist = (next: ICharacter[]) => {
    setCharacters(next);
    apiSaveCharacters(next).catch(() => toast.error('保存失败，请重试'));
  };

  // ── 行内编辑 ──
  const startEdit = () => {
    if (!selected) return;
    setEditName(selected.name);
    setEditDesc(selected.description || '');
    setEditing(true);
  };
  const saveEdit = () => {
    if (!selected) return;
    if (!editName.trim()) { toast.error('角色名称不能为空'); return; }
    const next = characters.map((c) =>
      c.id === selected.id ? { ...c, name: editName.trim(), description: editDesc } : c,
    );
    persist(next);
    setEditing(false);
    toast.success('已保存');
  };

  // ── 参考图上传（走 OSS 直传）──
  const handleUpload = async (file: File, target: 'detail' | 'create') => {
    if (!ossEnabled) { toast.error('OSS 未启用，无法上传参考图'); return; }
    setUploading(true);
    try {
      const fileName = `ref-${Date.now()}-${file.name.replace(/\s+/g, '_')}`;
      const res = await ingestFile(file, fileName);
      if (!res.success || !res.url) {
        toast.error(res.error || '上传失败');
        return null;
      }
      if (target === 'detail' && selected) {
        const next = characters.map((c) =>
          c.id === selected.id
            ? { ...c, referenceImages: [...(c.referenceImages || []), res.url] }
            : c,
        );
        persist(next);
        toast.success('参考图已添加');
      } else {
        setNewRefImage(res.url);
      }
      return res.url;
    } catch (e) {
      toast.error('上传异常：' + (e instanceof Error ? e.message : String(e)));
      return null;
    } finally {
      setUploading(false);
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>, target: 'detail' | 'create') => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) handleUpload(file, target);
  };

  // ── 设头像 / 删参考图 ──
  const setAsAvatar = (url: string) => {
    if (!selected) return;
    const next = characters.map((c) => (c.id === selected.id ? { ...c, avatar: url } : c));
    persist(next);
    toast.success('已设为头像');
  };
  const removeRefImage = (url: string) => {
    if (!selected) return;
    const next = characters.map((c) =>
      c.id === selected.id
        ? { ...c, referenceImages: (c.referenceImages || []).filter((u) => u !== url) }
        : c,
    );
    persist(next);
  };

  // ── 删除角色 ──
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDeleteCharacter(deleteTarget.id);
      const next = characters.filter((c) => c.id !== deleteTarget.id);
      setCharacters(next);
      if (selectedId === deleteTarget.id) setSelectedId(next[0]?.id ?? null);
      toast.success('角色已删除');
    } catch {
      toast.error('删除失败');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  // ── 用此角色创作 ──
  const useCharacter = () => {
    if (!selected) return;
    navigate('/workspace', { state: { character: selected } });
  };

  // ── 创建角色 ──
  const handleCreate = () => {
    if (!newName.trim()) { toast.error('请填写角色名称'); return; }
    if (!ossEnabled && !newRefImage) {
      // 允许无参考图创建，但提示
    }
    setCreating(true);
    const refImages = newRefImage ? [newRefImage] : (characters[0]?.referenceImages || []);
    const newChar: ICharacter = {
      id: `char-${Date.now()}`,
      name: newName.trim(),
      avatar: newRefImage || characters[0]?.avatar || '',
      description: newDesc || '新建角色',
      referenceImages: refImages,
      baseModel: 'Nano Banana 2 Lite',
      createdAt: new Date().toISOString(),
      source: 'user',
    };
    const next = [newChar, ...characters];
    persist(next);
    setSelectedId(newChar.id);
    setCreateOpen(false);
    setNewName('');
    setNewDesc('');
    setNewRefImage('');
    setCreating(false);
    toast.success('角色已创建');
  };

  const stats = selected ? statsMap[selected.id] : undefined;

  return (
    <div className="flex h-full flex-col">
      <TopBar onSettingsOpen={() => {}} onMediaPickerOpen={() => {}} />

      <div className="flex flex-1 min-h-0">
        {/* 左侧角色列表 */}
        <aside className="w-64 shrink-0 border-r border-zinc-800 bg-black flex flex-col">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <h2 className="text-sm font-bold text-white">角色管理</h2>
            <button
              onClick={() => setCreateOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors"
            >
              <Plus className="size-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {characters.map((char) => (
              <button
                key={char.id}
                onClick={() => { setSelectedId(char.id); setEditing(false); }}
                className={`flex w-full items-center gap-3 rounded-2xl p-2.5 text-left transition-all duration-300 ${
                  selectedId === char.id
                    ? 'bg-emerald-500/10 border border-emerald-500/20'
                    : 'hover:bg-zinc-800/50 border border-transparent'
                }`}
              >
                <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-full border-2 border-zinc-800">
                  {char.avatar ? (
                    <Image src={char.avatar} alt={char.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-zinc-800 text-zinc-500">
                      <User className="size-5" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm font-medium text-white">{char.name}</div>
                  <div className="truncate text-xs text-zinc-500">
                    {statsMap[char.id]?.totalGenerations
                      ? `已生成 ${statsMap[char.id].totalGenerations} 次`
                      : (char.baseModel || '未设置')}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* 右侧角色详情 */}
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <div className="mx-auto max-w-4xl p-8">
              {/* 头部 */}
              <div className="mb-8 flex items-start justify-between gap-4">
                <div className="flex items-center gap-5">
                  <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-full border-4 border-emerald-500/30">
                    {selected.avatar ? (
                      <Image src={selected.avatar} alt={selected.name} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-zinc-800 text-zinc-500">
                        <User className="size-10" />
                      </div>
                    )}
                    <div className="pointer-events-none absolute -top-4 -right-4 h-12 w-12 bg-emerald-500/20 blur-[24px] rounded-full" />
                  </div>
                  <div>
                    <h1 className="text-2xl font-black tracking-tight text-white">{selected.name}</h1>
                    <p className="mt-1 text-sm text-zinc-500">基础模型：{selected.baseModel || '未设置'}</p>
                    <p className="text-xs text-zinc-600">
                      创建于 {selected.createdAt ? new Date(selected.createdAt).toLocaleDateString('zh-CN') : '—'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {editing ? (
                    <>
                      <button
                        onClick={saveEdit}
                        className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-sm font-bold text-black hover:bg-emerald-400 transition-colors"
                      >
                        <Check className="size-4" /> 保存
                      </button>
                      <button
                        onClick={() => setEditing(false)}
                        className="flex items-center gap-1.5 rounded-full border border-zinc-800 px-4 py-2 text-sm text-white hover:bg-zinc-800/50 transition-colors"
                      >
                        <X className="size-4" /> 取消
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={startEdit}
                      className="flex items-center gap-1.5 rounded-full border border-zinc-800 px-4 py-2 text-sm text-white hover:bg-zinc-800/50 transition-colors"
                    >
                      <Edit3 className="size-4" /> 编辑
                    </button>
                  )}
                  <button
                    onClick={() => setDeleteTarget(selected)}
                    className="flex items-center gap-1.5 rounded-full border border-zinc-800 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    <Trash2 className="size-4" /> 删除
                  </button>
                  <button
                    onClick={useCharacter}
                    className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-sm font-bold text-black hover:bg-emerald-400 transition-colors"
                  >
                    <Sparkles className="size-4" /> 用此角色创作
                  </button>
                </div>
              </div>

              {/* 角色描述（可编辑） */}
              <div className="mb-8 rounded-[2rem] bg-zinc-900 border border-zinc-800 p-6 relative overflow-hidden">
                <div className="pointer-events-none absolute -top-10 right-0 h-32 w-32 bg-emerald-500/10 blur-[60px] rounded-full" />
                <h3 className="mb-3 text-sm font-bold text-white">角色描述</h3>
                {editing ? (
                  <div className="space-y-3">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="角色名称"
                      className="w-full rounded-2xl bg-zinc-800/50 px-4 py-2.5 text-sm font-medium text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50 transition-colors"
                    />
                    <textarea
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      placeholder="描述角色的外貌、气质、服饰特点..."
                      rows={4}
                      className="w-full resize-none rounded-2xl bg-zinc-800/50 px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50 transition-colors"
                    />
                  </div>
                ) : (
                  <p className="text-sm leading-relaxed text-zinc-300">{selected.description || '暂无角色描述'}</p>
                )}
              </div>

              {/* 参考形象图（真实上传 / 设头像 / 删除 / 下载） */}
              <div className="mb-8">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white">参考形象图</h3>
                  <button
                    onClick={() => uploadRef.current?.click()}
                    disabled={uploading || !ossEnabled}
                    className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                    {uploading ? '上传中...' : '添加参考图'}
                  </button>
                  <input
                    ref={uploadRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onFileChange(e, 'detail')}
                  />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {(selected.referenceImages || []).map((img, i) => (
                    <div
                      key={i}
                      className="group relative aspect-[3/4] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 transition-all duration-300 hover:border-zinc-700"
                    >
                      <Image src={img} alt={`参考图 ${i + 1}`} className="h-full w-full object-cover" />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100">
                        <button
                          title="设为头像"
                          onClick={() => setAsAvatar(img)}
                          className="flex items-center justify-center rounded-full bg-white/90 p-2 text-black hover:bg-white"
                        >
                          <Star className="size-4" />
                        </button>
                        <a
                          title="下载"
                          href={img}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-center rounded-full bg-white/90 p-2 text-black hover:bg-white"
                        >
                          <Download className="size-4" />
                        </a>
                        <button
                          title="删除"
                          onClick={() => removeRefImage(img)}
                          className="flex items-center justify-center rounded-full bg-red-500/90 p-2 text-white hover:bg-red-500"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                      {selected.avatar === img && (
                        <span className="absolute left-2 top-2 rounded-full bg-emerald-500/90 px-2 py-0.5 text-[10px] font-semibold text-black">
                          头像
                        </span>
                      )}
                    </div>
                  ))}
                  {(selected.referenceImages || []).length === 0 && (
                    <div className="col-span-full flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800 py-10 text-zinc-600">
                      <ImageIcon className="size-8 mb-2" />
                      <p className="text-xs">暂无参考图，点击右上角「添加参考图」上传</p>
                    </div>
                  )}
                </div>
              </div>

              {/* 生成记录（实时聚合，杜绝写死数字） */}
              <div>
                <h3 className="mb-4 text-sm font-bold text-white">生成记录</h3>
                <div className="rounded-[2rem] bg-zinc-900 border border-zinc-800 p-6">
                  {statsLoading ? (
                    <div className="flex items-center justify-center gap-2 text-sm text-zinc-500">
                      <Loader2 className="size-4 animate-spin" /> 统计中...
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 text-center">
                      <div className="flex-1">
                        <div className="text-3xl font-black text-white">{stats?.totalGenerations ?? 0}</div>
                        <div className="mt-1 text-xs text-zinc-500">总生成次数</div>
                      </div>
                      <div className="h-10 w-px bg-zinc-800" />
                      <div className="flex-1">
                        <div className="text-3xl font-black text-emerald-400">{stats?.favorites ?? 0}</div>
                        <div className="mt-1 text-xs text-zinc-500">收藏作品</div>
                      </div>
                      <div className="h-10 w-px bg-zinc-800" />
                      <div className="flex-1">
                        <div className="text-3xl font-black text-white">{(selected.referenceImages || []).length}</div>
                        <div className="mt-1 text-xs text-zinc-500">参考图数量</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center py-20">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-[2rem] bg-zinc-900 text-zinc-600">
                <User className="size-10" />
              </div>
              <p className="text-sm text-zinc-500 mb-4">暂无角色</p>
              <button
                onClick={() => setCreateOpen(true)}
                className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-sm font-bold text-black hover:bg-emerald-400 transition-colors"
              >
                <Plus className="size-4" /> 创建角色
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 新建角色弹窗 */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-[2rem] bg-zinc-900 border border-zinc-800 p-6">
            <h3 className="mb-5 text-lg font-bold text-white">创建新角色</h3>
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">角色名称</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="输入角色名称"
                  className="w-full rounded-2xl bg-zinc-800/50 px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">角色描述</label>
                <textarea
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="描述角色的外貌、气质、服饰特点..."
                  rows={4}
                  className="w-full resize-none rounded-2xl bg-zinc-800/50 px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">参考图（可选）</label>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => createUploadRef.current?.click()}
                    disabled={!ossEnabled || uploading}
                    className="flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-dashed border-zinc-700 text-zinc-500 hover:border-emerald-500/50 hover:text-emerald-400 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {uploading ? <Loader2 className="size-5 animate-spin" /> : (newRefImage ? <Image src={newRefImage} className="h-full w-full object-cover rounded-2xl" /> : <ImageIcon className="size-5" />)}
                  </button>
                  <span className="text-xs text-zinc-500">点击上传参考图（可选）</span>
                  <input
                    ref={createUploadRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onFileChange(e, 'create')}
                  />
                </div>
              </div>
            </div>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                onClick={() => setCreateOpen(false)}
                className="rounded-full border border-zinc-800 px-4 py-2 text-sm text-white hover:bg-zinc-800/50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-bold text-black hover:bg-emerald-400 transition-colors disabled:opacity-60"
              >
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[2rem] bg-zinc-900 border border-zinc-800 p-6">
            <h3 className="mb-2 text-lg font-bold text-white">删除角色</h3>
            <p className="text-sm leading-relaxed text-zinc-400">
              确定要删除角色「<span className="text-white">{deleteTarget.name}</span>」吗？该操作不可恢复，但已生成的素材会保留。
            </p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="rounded-full border border-zinc-800 px-4 py-2 text-sm text-white hover:bg-zinc-800/50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="rounded-full bg-red-500 px-5 py-2 text-sm font-bold text-white hover:bg-red-400 transition-colors disabled:opacity-60"
              >
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
