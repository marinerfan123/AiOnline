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
};
