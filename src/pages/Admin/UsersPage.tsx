// API 客户端 — 唯一数据持久化通道（浏览器本地不落盘）
// 所有数据（媒体/供应商/模型/设置/OSS/角色）一律存后端，浏览器本地不落盘。
// 用法：在需要数据的地方先 `await ensureApi()`，成功后各 apiGet* 才有数据可读。

import type { IMediaItem } from '@/data/media';
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Search, ShieldCheck, ShieldAlert, Trash2, Crown, Wallet, Lock, Key,
  X, Plus,
} from 'lucide-react';

const cn = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

let API_BASE = '';
let API_TOKEN = '';
let discoverPromise: Promise<boolean> | null = null;

/** 手动指定后端地址（一般不需要，ensureApi 会自动发现） */
export function initApi(baseUrl: string, token: string) {
  API_BASE = baseUrl.replace(/\/$/, '');
  API_TOKEN = token;
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_TOKEN}`,
  };
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  // 确保 API 已连接（首次调用时自动发现后端 + 获取 token）
  if (!API_TOKEN) await ensureApi();
  // credentials:'include' → 浏览器自动携带会话 cookie（后端 set-cookie 的 sid），用于 /api/generate 等需登录接口归属用户
  const res = await fetch(`${API_BASE}${path}`, { ...options, credentials: 'include', headers: { ...headers(), ...options?.headers } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * 确保 API 已连接（模块级缓存，只发现一次）。
 * 根据当前访问地址自动推导后端：http://<hostname>:3001 并获取 token。
 * 后端不可用时返回 false，调用方降级到内置默认数据（仅内存，不落盘）。
 */
export function ensureApi(): Promise<boolean> {
  if (API_BASE && API_TOKEN) return Promise.resolve(true);
  if (!discoverPromise) {
    discoverPromise = (async () => {
      try {
        // 同域：直接走相对路径
        let apiBase = '';
        if (typeof window !== 'undefined') {
          const { protocol, host } = window.location;
          apiBase = `${protocol}//${host}`;
        }
        const res = await fetch(`${apiBase}/api/token`, { headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
        if (res.ok) {
          const { token } = await res.json();
          initApi(apiBase, token);
          console.log(`[API] 已连接 ${apiBase}`);
          return true;
        }
      } catch {
        console.log('[API] 后端未启动，使用内置默认数据（不持久化）');
      }
      return false;
    })();
  }
  return discoverPromise;
}

// ─── Media ──────────────────────────────────────
export async function apiGetMedia(): Promise<any[]> {
  try { return await apiFetch('/api/media'); } catch { return []; }
}
export async function apiSaveMedia(items: any[]) {
  try { await apiFetch('/api/media', { method: 'POST', body: JSON.stringify(items) }); } catch {}
}
export async function apiDeleteMedia(id: string) {
  try { await apiFetch(`/api/media/${id}`, { method: 'DELETE' }); } catch {}
}
/**
 * 单条部分更新（探测失败时回写 status/errorMessage/failedAt 用）
 * 后端只更新传入的非空字段，不破坏其他字段
 */
export async function apiUpdateMedia(id: string, patch: Partial<IMediaItem>) {
  try { await apiFetch(`/api/media/${id}`, { method: 'PUT', body: JSON.stringify(patch) }); } catch {}
}
/** 媒体分类计数（侧边栏角标用） */
export interface MediaCounts {
  total: number;
  image: number;
  video: number;
  character: number;
  scene: number;
  prop: number;
  other: number;
  upload: number;
}
export async function apiGetMediaCounts(): Promise<MediaCounts | null> {
  try { return await apiFetch<MediaCounts>('/api/media/counts'); } catch { return null; }
}

/**
 * 代理下载外部图片（绕开浏览器 CORS）
 * 后端服务器对服务器 fetch，无 CORS 限制
 */
export async function apiProxyFetch(
  imageUrl: string,
  headers: Record<string, string> = {},
): Promise<{ success: boolean; base64?: string; contentType?: string; size?: number; message?: string }> {
  try {
    return await apiFetch('/api/proxy-fetch', {
      method: 'POST',
      body: JSON.stringify({ imageUrl, headers }),
    });
  } catch (e) {
    return { success: false, message: (e instanceof Error ? e.message : String(e)).slice(0, 100) };
  }
}

// ─── Settings ───────────────────────────────────
export async function apiGetSettings(): Promise<any> {
  try { return await apiFetch('/api/settings'); } catch { return {}; }
}
export async function apiSaveSettings(settings: Record<string, any>) {
  try { await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }); } catch {}
}

// ─── OSS ────────────────────────────────────────
export async function apiGetOss(): Promise<any> {
  try { return await apiFetch('/api/oss'); } catch { return {}; }
}
export async function apiSaveOss(config: Record<string, any>) {
  try { await apiFetch('/api/oss', { method: 'PUT', body: JSON.stringify(config) }); } catch {}
}
/**
 * 测试 OSS 连接（走后端代理）
 */
export async function apiTestOss(config: Record<string, any>): Promise<{
  success: boolean;
  message: string;
  files?: { name: string; size: number; lastModified: string }[];
}> {
  try {
    return await apiFetch('/api/oss/test', { method: 'POST', body: JSON.stringify(config) });
  } catch (e) {
    return { success: false, message: (e instanceof Error ? e.message : String(e)).slice(0, 100) };
  }
}

// ─── Characters ─────────────────────────────────
export async function apiGetCharacters(): Promise<any[]> {
  try { return await apiFetch('/api/characters'); } catch { return []; }
}
export async function apiSaveCharacters(items: any[]) {
  try { await apiFetch('/api/characters', { method: 'POST', body: JSON.stringify(items) }); } catch {}
}

/** 过滤掉刷新后失效的 blob URL 临时项（本地上传的临时文件不持久化） */
export function stripBlobItems<T extends { thumbnail?: string }>(items: T[]): T[] {
  return items.filter((m) => !m.thumbnail?.startsWith('blob:'));
}

// ─── 服务端生成分发 ─────────────────────────────
/**
 * 调用后端 /api/generate（默认异步）：立即返回 taskId，前端再用 taskId 轮询状态。
 */
export type GenerateResponse =
  | { status: 'pending'; taskId: string; error?: string }
  | { status: 'success' | 'failed'; taskId?: string; images?: string[]; error?: string; source?: string; usedProviders?: string[] };

export async function apiGenerate(payload: {
  model: string;
  prompt: string;
  ratio?: string;
  resolution?: string;
  count?: number;
  contentType?: 'image' | 'video';
  referenceImages?: string[];
  pendingIds?: string[]; // 把前端的 pending 占位 id 告诉后端，便于刷新恢复
  idempotencyKey?: string; // 幂等键：每次生成请求一个 UUID，防网络抖动双扣（后端必需）
}): Promise<GenerateResponse> {
  try {
    return await apiFetch('/api/generate', { method: 'POST', body: JSON.stringify(payload) }) as GenerateResponse;
  } catch (e) {
    return { status: 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 200), images: [] };
  }
}

// 查询单个生成任务状态（用于前端轮询 / 刷新恢复）
export async function apiGetGenerationStatus(taskId: string): Promise<{
  taskId: string;
  status: 'running' | 'done' | 'failed' | 'not_found' | 'unknown';
  result?: { images?: string[]; source?: string; usedProviders?: string[] } | null;
  error?: string;
  pendingIds?: string[];
  model?: string;
  prompt?: string;
  count?: number;
  contentType?: string;
  clientMeta?: Record<string, unknown>;
  createdAt?: string;
  completedAt?: string;
}> {
  try {
    return await apiFetch(`/api/generate/status/${encodeURIComponent(taskId)}`);
  } catch (e) {
    return { taskId, status: 'unknown', error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

// 列出在途任务（用于页面刷新后批量恢复）
export async function apiListActiveGenerations(): Promise<{
  tasks: Array<{
    taskId: string;
    status: 'running' | 'done' | 'failed';
    result?: { images?: string[]; source?: string; usedProviders?: string[] } | null;
    error?: string;
    pendingIds?: string[];
    model?: string;
    prompt?: string;
    count?: number;
    contentType?: string;
    clientMeta?: Record<string, unknown>;
    createdAt?: string;
    completedAt?: string;
  }>;
  error?: string;
}> {
  try {
    return await apiFetch('/api/generate/active');
  } catch (e) {
    return { tasks: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

// ─── 智能体 skill：AI 提示词优化 ─────────────────────
/**
 * 调用后端 /api/agent/optimize-prompt：后台自动选一个启用的 type=text 推理模型，
 * 把用户原始 prompt 改写成更适合图像/视频生成的英文结构化提示词。
 * 失败时：
 *   - code='NO_REASONING_MODEL' → 提示用户去「模型 Hub」添加 text 类型模型
 *   - 其他 error → 通用错误消息
 */
export async function apiOptimizePrompt(prompt: string): Promise<{
  success: boolean;
  content?: string;
  error?: string;
  code?: 'NO_REASONING_MODEL' | string;
  modelUsed?: string;
  providerId?: string;
}> {
  try {
    return await apiFetch('/api/agent/optimize-prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
  } catch (e) {
    return { success: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

// ─── 同步服务商模型列表（后端代理，避免前端持有真实 Key）───
export async function apiSyncProviderModels(id: string): Promise<{ success: boolean; models?: Array<{ id: string; name: string }>; message?: string }> {
  try {
    return await apiFetch(`/api/providers/${id}/sync`, { method: 'POST' });
  } catch (e) {
    return { success: false, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

// ─── 测试服务商端点（后端代理）───
export async function apiTestProviderEndpoint(
  id: string,
  endpoint: Record<string, unknown>,
  vars: Record<string, unknown>,
): Promise<{ success: boolean; status?: number; body?: unknown; message?: string }> {
  try {
    return await apiFetch(`/api/providers/${id}/test-endpoint`, { method: 'POST', body: JSON.stringify({ endpoint, vars }) });
  } catch (e) {
    return { success: false, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

export async function apiTestProviderDefault(
  id: string,
  testInput: string,
): Promise<{ success: boolean; status?: number; body?: unknown; message?: string }> {
  try {
    return await apiFetch(`/api/providers/${id}/test-default`, { method: 'POST', body: JSON.stringify({ testInput }) });
  } catch (e) {
    return { success: false, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

// ─── Auth（cookie 会话；fetch 带 credentials:'include' 自动携带 sid）───
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  credits: number;
  role: string;
  status?: string;
  plan?: string;
}

/** 注册：成功后后端种下会话 cookie，返回用户（含赠送积分） */
export async function apiRegister(
  email: string,
  password: string,
  displayName?: string,
): Promise<{ ok: boolean; user: AuthUser }> {
  return apiFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName }),
  });
}

/** 登录：成功后后端种下会话 cookie */
export async function apiLogin(email: string, password: string): Promise<{ ok: boolean; user: AuthUser }> {
  return apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

/** 登出：清除会话 cookie */
export async function apiLogout(): Promise<{ ok: boolean }> {
  return apiFetch('/api/auth/logout', { method: 'POST' });
}

/** 当前登录用户（无 cookie 时 401，已被 apiFetch 抛错，这里兜底返回空） */
export async function apiMe(): Promise<{ user?: AuthUser }> {
  try {
    return await apiFetch('/api/auth/me');
  } catch {
    return {};
  }
}

// ─── 电商（Phase 5 / AI 市集）───
export interface ShopProduct {
  id: number | string;
  shopId: number | string;
  title: string;
  subtitle?: string;
  coverUrl?: string;
  priceCents: number;
  creditPrice: number;
  stock: number;
  category: string;
  aiFields?: Record<string, unknown>;
  status: string;
  createdAt?: string;
  shopName?: string;
}
export async function apiGetShopProducts(params: { cat?: string; q?: string; limit?: number; offset?: number } = {}): Promise<{ items: ShopProduct[]; total: number; limit: number; offset: number }> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, String(v)); });
  try { return await apiFetch(`/api/shop/products?${qs.toString()}`); } catch { return { items: [], total: 0, limit: 0, offset: 0 }; }
}
export interface ShopProductDetail {
  product: ShopProduct & { description?: string; shopDescription?: string };
  skus: Array<{ id: number | string; productId: number | string; specs: Record<string, unknown>; priceCents: number; creditPrice: number; stock: number; createdAt?: string }>;
  reviews: Array<{ id: number | string; productId: number | string; userId: string; rating: number; content?: string; createdAt?: string }>;
}
export async function apiGetProduct(id: string): Promise<ShopProductDetail | null> {
  try { return await apiFetch(`/api/products/${encodeURIComponent(id)}`); } catch { return null; }
}
export interface CartItem {
  id: number | string;
  productId: number | string;
  skuId: number | string;
  qty: number;
  title: string;
  coverUrl?: string;
  productStatus: string;
  attrs?: Record<string, unknown> | null;
  skuStock?: number | null;
  unitCreditPrice: number;
  subtotal: number;
}
export async function apiGetCart(): Promise<CartItem[]> {
  try { return await apiFetch('/api/cart'); } catch { return []; }
}
export async function apiAddToCart(productId: string | number, qty = 1, skuId?: string | number): Promise<{ ok: boolean; error?: string }> {
  try { await apiFetch('/api/cart', { method: 'POST', body: JSON.stringify({ productId, qty, skuId }) }); return { ok: true }; }
  catch (e) { return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
}
export async function apiUpdateCartItem(id: string | number, qty: number): Promise<{ ok: boolean; error?: string }> {
  try { await apiFetch(`/api/cart/${encodeURIComponent(String(id))}`, { method: 'PUT', body: JSON.stringify({ qty }) }); return { ok: true }; }
  catch (e) { return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
}
export async function apiRemoveCartItem(id: string | number): Promise<{ ok: boolean; error?: string }> {
  try { await apiFetch(`/api/cart/${encodeURIComponent(String(id))}`, { method: 'DELETE' }); return { ok: true }; }
  catch (e) { return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
}
export interface ShopOrder {
  id: string;
  orderNo: string;
  userId: string;
  totalCents: number;
  totalCredits: number;
  creditUsed: number;
  payChannel?: string;
  payStatus: string;
  createdAt?: string;
  paidAt?: string | null;
  itemCount?: number;
}
export async function apiCreateOrder(idempotencyKey: string): Promise<{ ok: boolean; order?: { id: string; orderNo: string; totalCredits: number; payStatus: string }; idempotent?: boolean; error?: string }> {
  try { return await apiFetch('/api/orders', { method: 'POST', body: JSON.stringify({ idempotencyKey }) }); }
  catch (e) { return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
}
export async function apiGetOrders(): Promise<ShopOrder[]> {
  try { return await apiFetch('/api/orders'); } catch { return []; }
}
export async function apiGetOrder(id: string): Promise<{ order: ShopOrder; items: any[] } | null> {
  try { return await apiFetch(`/api/orders/${encodeURIComponent(id)}`); } catch { return null; }
}

// ─── 管理后台（M3 总控台 / M4 智能体层 / M2 账务）───
// 走会话 cookie（管理员登录态），无需额外 header；ensureApi 已注入 API_TOKEN 兜底。
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  rewardCredits: number;
  rechargeCredits: number;
  credits: number;
  status: string;
  plan: string;
  createdAt: string;
}
export async function apiAdminUsers(params: { q?: string; role?: string; limit?: number; offset?: number } = {}): Promise<{ items: AdminUser[]; total: number }> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, String(v)); });
  try { return await apiFetch(`/api/admin/users?${qs.toString()}`); } catch { return { items: [], total: 0 }; }
}

export async function apiAdminRecharge(
  userId: string,
  amount: number,
  note?: string,
  pool: 'reward' | 'recharge' = 'recharge',
): Promise<{ ok: boolean; credits?: number; error?: string }> {
  try {
    return await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/credits`, {
      method: 'POST',
      body: JSON.stringify({ amount, note, pool }),
    });
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

export async function apiAdminSetPassword(userId: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

export async function apiAdminSetUserStatus(userId: string, status: 'active' | 'suspended'): Promise<{ ok: boolean; status?: string; error?: string }> {
  try { return await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/status`, { method: 'POST', body: JSON.stringify({ status }) }); }
  catch (e) { return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
}
export async function apiAdminSetUserRole(userId: string, role: 'user' | 'admin'): Promise<{ ok: boolean; role?: string; error?: string }> {
  try { return await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/role`, { method: 'PUT', body: JSON.stringify({ role }) }); }
  catch (e) { return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
}
export interface DeleteUserResult {
  ok: boolean;
  error?: string;
  hasResources?: boolean;
  counts?: Record<string, number>;
  total?: number;
}
export async function apiAdminDeleteUser(userId: string, force = false): Promise<DeleteUserResult> {
  try {
    await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}${force ? '?force=1' : ''}`, { method: 'DELETE' });
    return { ok: true };
  } catch (e) {
    const raw = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    const body = raw.match(/^API \d+:\s*(.*)$/)?.[1] || raw;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.error === 'string') {
        return {
          ok: false,
          error: parsed.error,
          hasResources: !!parsed.hasResources,
          counts: parsed.counts || {},
          total: parsed.total || 0,
        };
      }
    } catch {}
    return { ok: false, error: raw || '删除失败' };
  }
}

export interface AdminTx {
  id: number;
  userId: string;
  user: string;
  kind: string;
  amount: number;
  balanceAfter: number | null;
  ref?: string;
  createdAt: string;
}
export async function apiAdminTransactions(params: { limit?: number; offset?: number; type?: string; userId?: string } = {}): Promise<{ items: AdminTx[]; total: number }> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, String(v)); });
  try { return await apiFetch(`/api/admin/transactions?${qs.toString()}`); } catch { return { items: [], total: 0 }; }
}

export interface AdminAgent {
  key: string;
  name: string;
  enabled: boolean;
  dailyBudget: number;
  config: Record<string, unknown>;
  createdAt: string;
}
export async function apiAdminAgents(): Promise<AdminAgent[]> {
  try { return await apiFetch('/api/admin/agents'); } catch { return []; }
}
export async function apiAdminUpsertAgent(a: { key: string; name: string; enabled?: boolean; dailyBudget?: number; config?: Record<string, unknown> }): Promise<{ ok: boolean; error?: string }> {
  try { return await apiFetch('/api/admin/agents', { method: 'POST', body: JSON.stringify(a) }); } catch (e) { return { ok: false, error: (e as Error).message }; }
}
export async function apiAdminToggleAgent(key: string, enabled: boolean): Promise<{ ok: boolean }> {
  try { return await apiFetch(`/api/admin/agents/${encodeURIComponent(key)}/toggle`, { method: 'PUT', body: JSON.stringify({ enabled }) }); } catch { return { ok: false }; }
}

export interface AgentProvider {
  id: string;
  agentKey: string;
  provider: string;
  model: string;
  weight: number;
  priority: number;
  costPerCall: number;
  enabled: boolean;
  createdAt: string;
}
export async function apiAdminAgentProviders(agentKey?: string): Promise<AgentProvider[]> {
  try { return await apiFetch(agentKey ? `/api/admin/agents/${encodeURIComponent(agentKey)}/providers` : '/api/admin/agent-providers'); } catch { return []; }
}
export async function apiAdminUpsertAgentProvider(p: { id?: string; agentKey: string; provider: string; model: string; weight?: number; priority?: number; costPerCall?: number; enabled?: boolean }): Promise<{ ok: boolean; error?: string }> {
  try { return await apiFetch('/api/admin/agent-providers', { method: 'POST', body: JSON.stringify(p) }); } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export interface AgentRule {
  id: string;
  name: string;
  trigger: string;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}
export async function apiAdminAgentRules(): Promise<AgentRule[]> {
  try { return await apiFetch('/api/admin/agent-rules'); } catch { return []; }
}
export async function apiAdminUpsertAgentRule(r: { id?: string; name: string; trigger: string; condition?: Record<string, unknown>; action?: Record<string, unknown>; enabled?: boolean }): Promise<{ ok: boolean; error?: string }> {
  try { return await apiFetch('/api/admin/agent-rules', { method: 'POST', body: JSON.stringify(r) }); } catch (e) { return { ok: false, error: (e as Error).message }; }
}
export async function apiAdminToggleAgentRule(id: string, enabled: boolean): Promise<{ ok: boolean }> {
  try { return await apiFetch(`/api/admin/agent-rules/${encodeURIComponent(id)}/toggle`, { method: 'PUT', body: JSON.stringify({ enabled }) }); } catch { return { ok: false }; }
}

// ─── 用户管理页（M3 总控台）───
export default function UsersPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [rechargeModal, setRechargeModal] = useState<AdminUser | null>(null);
  const [passwordModal, setPasswordModal] = useState<AdminUser | null>(null);
  const [rechargeForm, setRechargeForm] = useState({ amount: '', pool: 'recharge' as 'reward' | 'recharge', note: '' });
  const [passwordForm, setPasswordForm] = useState({ password: '' });
  const [submitting, setSubmitting] = useState(false);
  // 删除有资源的用户：二次确认弹窗（后端返回 hasResources 时触发）
  const [deleteConfirm, setDeleteConfirm] = useState<{ user: AdminUser; counts: Record<string, number>; total: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiAdminUsers({ q: q || undefined, role: role || undefined, limit: 100 });
    setItems(r.items || []);
    setTotal(r.total || 0);
    setLoading(false);
  }, [q, role]);

  useEffect(() => { load(); }, [load]);

  const toggleStatus = async (u: AdminUser) => {
    const next: 'active' | 'suspended' = u.status === 'active' ? 'suspended' : 'active';
    const r = await apiAdminSetUserStatus(u.id, next);
    if (r.ok) { toast.success(`已${next === 'active' ? '启用' : '停用'} ${u.displayName}`); load(); }
    else toast.error(r.error || '操作失败');
  };
  const toggleRole = async (u: AdminUser) => {
    const next: 'user' | 'admin' = u.role === 'admin' ? 'user' : 'admin';
    const r = await apiAdminSetUserRole(u.id, next);
    if (r.ok) { toast.success(`已设为${next === 'admin' ? '管理员' : '普通用户'}`); load(); }
    else toast.error(r.error || '操作失败');
  };
  const remove = async (u: AdminUser) => {
    // 先尝试普通删除；若用户存在关联资源，后端返回 hasResources + counts，弹二次确认框
    const r = await apiAdminDeleteUser(u.id);
    if (r.ok) { toast.success('已删除'); load(); return; }
    if (r.hasResources) {
      setDeleteConfirm({ user: u, counts: r.counts || {}, total: r.total || 0 });
      return;
    }
    toast.error(r.error || '删除失败');
  };
  // 二次确认后强制执行级联删除
  const confirmForceDelete = async () => {
    if (!deleteConfirm) return;
    const u = deleteConfirm.user;
    setSubmitting(true);
    const r = await apiAdminDeleteUser(u.id, true);
    setSubmitting(false);
    if (r.ok) {
      toast.success('已删除并清除其全部资源');
      setDeleteConfirm(null);
      load();
    } else {
      toast.error(r.error || '删除失败');
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white">用户管理</h1>
          <p className="text-xs text-zinc-500">M3 · 总控台 · 用户账号 / 角色 / 状态管理</p>
        </div>
        <span className="rounded-2xl bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300">共 {total} 个用户</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索邮箱 / 昵称"
            className="w-64 rounded-2xl bg-white/5 pl-9 pr-3 py-2 text-sm text-white placeholder:text-zinc-600 border border-white/10 focus:border-emerald-500/50 focus:outline-none"
          />
        </div>
        {(['', 'user', 'admin'] as const).map((rv) => (
          <button
            key={rv}
            onClick={() => setRole(rv)}
            className={cn(
              'rounded-2xl px-3 py-1.5 text-sm transition-colors',
              role === rv ? 'bg-emerald-500 text-black' : 'bg-white/5 text-zinc-300 hover:bg-white/10',
            )}
          >
            {rv === '' ? '全部角色' : rv === 'admin' ? '管理员' : '普通用户'}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500">
              <th className="py-2.5 px-4 font-medium">用户</th>
              <th className="py-2.5 px-4 font-medium">角色</th>
              <th className="py-2.5 px-4 font-medium">积分（赠送 / 充值 / 合计）</th>
              <th className="py-2.5 px-4 font-medium">状态</th>
              <th className="py-2.5 px-4 font-medium">注册时间</th>
              <th className="py-2.5 px-4 font-medium text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading && <tr><td colSpan={6} className="py-6 text-center text-xs text-zinc-500">加载中…</td></tr>}
            {!loading && items.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-xs text-zinc-500">暂无用户</td></tr>}
            {!loading && items.map((u) => (
              <tr key={u.id} className="text-zinc-200">
                <td className="py-2.5 px-4">
                  <div className="font-medium text-white">{u.displayName}</div>
                  <div className="text-xs text-zinc-500">{u.email}</div>
                </td>
                <td className="py-2.5 px-4">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs', u.role === 'admin' ? 'bg-violet-400/10 text-violet-300' : 'bg-white/10 text-zinc-300')}>{u.role}</span>
                </td>
                <td className="py-2.5 px-4">
                  <div className="text-xs text-zinc-500">
                    <span className="text-violet-300">{Number(u.rewardCredits || 0).toFixed(1)}</span>
                    <span className="mx-1">/</span>
                    <span className="text-sky-300">{Number(u.rechargeCredits || 0).toFixed(1)}</span>
                    <span className="mx-1">/</span>
                    <span className="font-medium text-emerald-300">{Number(u.credits || 0).toFixed(1)}</span>
                  </div>
                </td>
                <td className="py-2.5 px-4">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs', u.status === 'active' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-rose-400/10 text-rose-300')}>{u.status}</span>
                </td>
                <td className="py-2.5 px-4 text-xs text-zinc-500">{u.createdAt ? new Date(u.createdAt).toLocaleString() : '—'}</td>
                <td className="py-2.5 px-4 text-right">
                  <div className="flex justify-end gap-1">
                    <button onClick={() => { setRechargeForm({ amount: '', pool: 'recharge', note: '' }); setRechargeModal(u); }} title="调账（赠送/充值积分）" className="flex size-8 items-center justify-center rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white transition-colors">
                      <Wallet className="size-4" />
                    </button>
                    <button onClick={() => { setPasswordForm({ password: '' }); setPasswordModal(u); }} title="修改密码" className="flex size-8 items-center justify-center rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white transition-colors">
                      <Key className="size-4" />
                    </button>
                    <button onClick={() => toggleStatus(u)} title={u.status === 'active' ? '停用' : '启用'} className="flex size-8 items-center justify-center rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white transition-colors">
                      {u.status === 'active' ? <ShieldAlert className="size-4" /> : <ShieldCheck className="size-4" />}
                    </button>
                    <button onClick={() => toggleRole(u)} title="切换角色" className="flex size-8 items-center justify-center rounded-lg bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white transition-colors">
                      <Crown className="size-4" />
                    </button>
                    <button onClick={() => remove(u)} title="删除" className="flex size-8 items-center justify-center rounded-lg bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 transition-colors">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 调账弹窗 */}
      {rechargeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">用户调账</h3>
              <button onClick={() => setRechargeModal(null)} className="text-zinc-500 hover:text-zinc-300"><X className="size-4" /></button>
            </div>
            <div className="mb-4 text-xs text-zinc-400">
              {rechargeModal.displayName}（{rechargeModal.email}）
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-500">调整池</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setRechargeForm({ ...rechargeForm, pool: 'recharge' })}
                    className={cn('flex-1 rounded-xl border px-3 py-2 text-xs', rechargeForm.pool === 'recharge' ? 'border-sky-500/50 bg-sky-500/10 text-sky-300' : 'border-zinc-700 text-zinc-400 hover:border-zinc-600')}
                  >充值积分</button>
                  <button
                    onClick={() => setRechargeForm({ ...rechargeForm, pool: 'reward' })}
                    className={cn('flex-1 rounded-xl border px-3 py-2 text-xs', rechargeForm.pool === 'reward' ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-zinc-700 text-zinc-400 hover:border-zinc-600')}
                  >赠送积分</button>
                </div>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">金额（正数增加，负数扣减，最多 1 位小数）</span>
                <input
                  type="number"
                  step="0.1"
                  value={rechargeForm.amount}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (/^-?\d*\.?\d{0,1}$/.test(val)) setRechargeForm({ ...rechargeForm, amount: val });
                  }}
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                  placeholder="如 100 或 -50.5"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">备注</span>
                <input
                  value={rechargeForm.note}
                  onChange={(e) => setRechargeForm({ ...rechargeForm, note: e.target.value })}
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                  placeholder="调账原因"
                />
              </label>
            </div>
            <div className="mt-5 flex gap-2">
              <button
                disabled={submitting || rechargeForm.amount === '' || Number(rechargeForm.amount) === 0}
                onClick={async () => {
                  setSubmitting(true);
                  const r = await apiAdminRecharge(
                    rechargeModal.id,
                    Number(rechargeForm.amount),
                    rechargeForm.note,
                    rechargeForm.pool,
                  );
                  setSubmitting(false);
                  if (r.ok) {
                    toast.success('调账成功');
                    setRechargeModal(null);
                    setRechargeForm({ amount: '', pool: 'recharge', note: '' });
                    load();
                  } else {
                    toast.error(r.error || '调账失败');
                  }
                }}
                className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-emerald-500 py-2 text-sm font-bold text-black hover:bg-emerald-400 disabled:opacity-50"
              >
                {submitting ? '处理中…' : '确认调账'}
              </button>
              <button
                onClick={() => setRechargeModal(null)}
                className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 改密弹窗 */}
      {passwordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">修改密码</h3>
              <button onClick={() => setPasswordModal(null)} className="text-zinc-500 hover:text-zinc-300"><X className="size-4" /></button>
            </div>
            <div className="mb-4 text-xs text-zinc-400">
              {passwordModal.displayName}（{passwordModal.email}）
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">新密码（至少 6 位）</span>
              <input
                type="password"
                value={passwordForm.password}
                onChange={(e) => setPasswordForm({ password: e.target.value })}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500/50"
                placeholder="输入新密码"
              />
            </label>
            <div className="mt-5 flex gap-2">
              <button
                disabled={submitting || passwordForm.password.length < 6}
                onClick={async () => {
                  setSubmitting(true);
                  const r = await apiAdminSetPassword(passwordModal.id, passwordForm.password);
                  setSubmitting(false);
                  if (r.ok) {
                    toast.success('密码已修改');
                    setPasswordModal(null);
                    setPasswordForm({ password: '' });
                  } else {
                    toast.error(r.error || '修改失败');
                  }
                }}
                className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-emerald-500 py-2 text-sm font-bold text-black hover:bg-emerald-400 disabled:opacity-50"
              >
                <Lock className="size-4" /> {submitting ? '保存中…' : '确认修改'}
              </button>
              <button
                onClick={() => setPasswordModal(null)}
                className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除有资源的用户：二次确认弹窗 */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-zinc-900 p-5 shadow-2xl">
            <div className="mb-3 flex items-center gap-2">
              <Trash2 className="size-5 text-red-400" />
              <h3 className="text-base font-semibold text-white">确认删除该用户及其全部资源？</h3>
            </div>
            <div className="mb-4 text-xs text-zinc-400">
              即将删除 <span className="text-white">{deleteConfirm.user.displayName}</span>（{deleteConfirm.user.email}）。
              该用户存在以下关联内容，删除后将<span className="text-red-300">一并清除且不可恢复</span>：
            </div>
            <div className="mb-4 space-y-1.5 rounded-xl border border-white/10 bg-black/30 p-3">
              {([
                ['generationTasks', '生成任务'],
                ['media', '素材 / 图片'],
                ['referenceStyles', '参考图样式'],
                ['characters', '角色'],
                ['studioProjects', '创作项目'],
                ['feedback', '反馈'],
                ['reports', '举报'],
              ] as const).map(([key, label]) => {
                const c = deleteConfirm.counts[key] || 0;
                if (c <= 0) return null;
                return (
                  <div key={key} className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400">{label}</span>
                    <span className="font-medium text-zinc-200">{c} 项</span>
                  </div>
                );
              })}
              <div className="flex items-center justify-between border-t border-white/10 pt-1.5 text-xs">
                <span className="text-zinc-500">合计</span>
                <span className="font-semibold text-red-300">{deleteConfirm.total} 项资源</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                disabled={submitting}
                onClick={confirmForceDelete}
                className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-red-500 py-2 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-50"
              >
                <Trash2 className="size-4" /> {submitting ? '删除中…' : '确认删除并清除资源'}
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
