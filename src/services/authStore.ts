// 轻量认证状态仓库（模块级 pub/sub，避免 prop drilling）
// 会话为 httpOnly cookie（后端 set-cookie），fetch 已带 credentials:'include' 自动携带。
import { useSyncExternalStore } from 'react';
import { apiMe, apiLogin, apiRegister, apiLogout, type AuthUser } from './api';
import { reloadModelHubAfterAuth } from '@/hooks/useModelHub';

interface AuthState {
  user: AuthUser | null;
  ready: boolean; // 是否已尝试过初始化（避免首屏闪烁）
  modalOpen: boolean; // 登录/注册弹窗
}

let state: AuthState = { user: null, ready: false, modalOpen: false };
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

export function subscribeAuth(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function getAuthState() {
  return state;
}

export function setAuthModalOpen(v: boolean) {
  if (state.modalOpen === v) return;
  state = { ...state, modalOpen: v };
  emit();
}

/** 应用启动调用一次：拉取当前会话用户 */
export async function initAuth() {
  try {
    const r = await apiMe();
    if (r && r.user) state = { ...state, user: r.user, ready: true };
    else state = { ...state, ready: true };
  } catch {
    state = { ...state, ready: true };
  }
  emit();
}

export async function login(email: string, password: string) {
  const r = await apiLogin(email, password);
  state = { ...state, user: r.user };
  emit();
  await reloadModelHubAfterAuth();
  return r;
}

export async function register(email: string, password: string, displayName?: string) {
  const r = await apiRegister(email, password, displayName);
  state = { ...state, user: r.user };
  emit();
  await reloadModelHubAfterAuth();
  return r;
}

export async function logout() {
  try {
    await apiLogout();
  } catch {
    /* 忽略：无论如何清除本地状态 */
  }
  state = { ...state, user: null };
  emit();
}

/** 刷新当前用户（生成扣费后更新积分显示） */
export async function refreshUser() {
  try {
    const r = await apiMe();
    if (r && r.user) {
      state = { ...state, user: r.user };
      emit();
    }
  } catch {
    /* 忽略 */
  }
}

/** React 组件订阅认证状态 */
export function useAuth() {
  return useSyncExternalStore(subscribeAuth, getAuthState, getAuthState);
}
