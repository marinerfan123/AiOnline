// 平台能力客户端（脱离飞书 SDK 后使用原生 fetch + console.log）
export const logger = {
  info: (...args: unknown[]) => console.log('[LOG]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERR]', ...args),
};

export const capabilityClient = {
  /** 检查某项能力是否可用（mock 全部可用） */
  async isAvailable(capability: string): Promise<boolean> {
    console.log('[capability] check', capability, '→ true');
    return true;
  },
  /** 旧飞书能力已下线：统一抛错走前端 catch 的「能力暂不可用」兜底 */
  load(capability: string) {
    return {
      async call(_action: string, _payload?: unknown): Promise<never> {
        throw new Error(`能力未接入：${capability}（飞书 SDK 已下线，走服务端 /api/agent/optimize-prompt）`);
      },
    };
  },
};
