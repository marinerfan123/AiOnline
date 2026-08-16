/**
 * 探测图片 URL 能否正常加载。
 * 用途：生成结果里的 URL 可能是服务商临时链接（短期过期），
 * 加载失败的 URL 会在 MediaCard 显示"裂图"占位，体验极差。
 * 探测后失败的会被标记为 status='failed'，渲染专用占位 + 原因。
 *
 * 跨域图片：CORS 头只影响 canvas getImageData，不影响 <img> 的 onload/onerror。
 * 所以这个探测在跨域场景下也可靠 —— 服务器返回 image/* 200 就 onload，
 * 返回 4xx/5xx/网络错就 onerror。
 */
export function probeImageLoad(url: string, timeoutMs = 8000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!url || typeof url !== 'string') {
      resolve({ ok: false, error: '图片链接为空' });
      return;
    }
    const img = new Image();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      img.src = '';
      resolve({ ok: false, error: `图片加载超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 进一步：拿到尺寸判断。极端场景 0x0 也算失败。
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        resolve({ ok: false, error: '图片尺寸异常（0×0）' });
      } else {
        resolve({ ok: true });
      }
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: '图片链接已失效（404/网络错误）' });
    };
    img.src = url;
  });
}
