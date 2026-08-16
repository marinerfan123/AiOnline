'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
type ImageFormat = 'jpg' | 'png' | 'webp' | 'bmp' | 'gif' | 'tiff';

type NativeImgProps = React.ComponentPropsWithoutRef<'img'>;

export interface ImageProps extends NativeImgProps {
  quality?: number;
  format?: ImageFormat;
  breakpoints?: Array<number>;
}

const DEFAULT_QUALITY = 80;
const DEFAULT_RESOLUTIONS: number[] = [
  16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048,
  3840,
];

const SRC_ALLOWLIST = [
  '/runtime/api/v1/storage/object/',
  '/aily/api/v1/feisuda/attachments/',
  '/aily/api/v1/files/static/',
];

function getClosestResolution(target: number): number {
  return DEFAULT_RESOLUTIONS.reduce((prev, curr) => {
    return Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev;
  });
}

function applyParamsToUrl(
  src: string,
  params: Record<string, string | number | undefined>,
): string {
  const search = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      return `${k},${v}`;
    })
    .join('/');
  if (!search) return src;

  const [pathAndQuery = '', hash] = src.split('#');
  const [base, query] = pathAndQuery.split('?');
  const urlParams = new URLSearchParams(query);
  urlParams.set('x-tos-process', `image/${search}`);

  return `${base}?${urlParams.toString()}${hash ? '#' + hash : ''}`;
}

function isTargetSrc(originSrc: string) {
  return SRC_ALLOWLIST.some((item) => originSrc.includes(item));
}

function supportWebp() {
  try {
    return (
      document
        .createElement('canvas')
        .toDataURL('image/webp')
        .indexOf('data:image/webp') === 0
    );
  } catch (err) {
    return false;
  }
}

function buildSrcSet(
  src: string,
  widths: number[],
  format: ImageFormat | undefined,
  quality: number,
  width?: number,
  sizes?: string,
): string | undefined {
  if (!widths || widths.length === 0 || (!width && !sizes)) return undefined;
  const fmt = format;
  if (width) {
    return [1, 2]
      .map((dpr) => {
        const targetWidth = getClosestResolution(width * dpr);
        return `${applyParamsToUrl(src, { resize: `w_${targetWidth}`, quality: `Q_${quality}`, format: fmt })} ${dpr}x`;
      })
      .join(', ');
  }
  return widths
    .map(
      (w) =>
        `${applyParamsToUrl(src, { resize: `w_${w}`, quality: `Q_${quality}`, format: fmt })} ${w}w`,
    )
    .join(', ');
}

export const Image = React.forwardRef<HTMLImageElement, ImageProps>(
  (
    {
      src,
      width,
      height,
      quality = DEFAULT_QUALITY,
      format,
      sizes,
      srcSet: userSrcSet,
      breakpoints = DEFAULT_RESOLUTIONS,
      className,
      loading = 'lazy',
      decoding = 'async',
      onError,
      ...rest
    },
    ref,
  ) => {
    const [errored, setErrored] = React.useState(false);
    const defaultFormat = React.useMemo(
      () => (supportWebp() ? 'webp' : undefined),
      [],
    );

    // 关键：src 变化时重置 errored。否则某张图 onError 一次后，即便随后换成有效 URL（如 OSS
    // 永久链接回填、详情面板切换、列表复用同一组件实例），errored 仍卡在 true → 永远返回 null
    // 卡空白。这正是「过一会又裂 / 刷新后裂 / 点裂图详情也裂」在 UI 层的残留态根因。
    // 换成新 src 视为一次新的加载机会。
    React.useEffect(() => {
      setErrored(false);
    }, [src]);

    const handleError = React.useCallback(
      (e: React.SyntheticEvent<HTMLImageElement>) => {
      setErrored(true);
      onError?.(e);
    },
      [onError],
    );

    // 关键防线：当 src 为空/缺失时，禁止渲染 <img src="">—— 浏览器把空 src 解释为
    // "加载当前页面"，会发起对当前 URL 的整页 HTTP 请求，整页被覆盖、React 子树被卸载，
    // 进而导致 WorkspacePage / MediaCard 等组件中的图片瞬间消失（控制台 React warning
    // "An empty string (\"\") was passed to the src attribute" 的根因）。
    // 占位由调用方决定（生成中 spinner / 失败红卡 / 空占位等），这里直接返回 null。
    if (!src || typeof src !== 'string') {
      return null;
    }

    // 加载失败：绝不渲染破图 <img src={undefined}>（浏览器会显示裂图图标 + alt 文字）。
    // 直接返回 null，把"占位/兜底"交给调用方（MediaCard 的 isFailed 红卡、生成中 spinner 等），
    // 彻底消灭"带破图图标的灰图"。这正是 #576 / 第九章 G 条规定的真正修复点。
    if (errored) {
      return null;
    }

    // 当 src 不在白名单时，直接渲染原生 img（跳过 srcSet 优化），保留所有原生属性
    if (!isTargetSrc(src)) {
      return (
        <img
          {...rest}
          ref={ref}
          src={src}
          width={width}
          height={height}
          sizes={sizes}
          srcSet={userSrcSet}
          className={cn(
            'bg-linear-to-b from-gray-50/20 to-gray-200/20',
            className,
          )}
          loading={loading}
          decoding={decoding}
          onError={handleError}
        />
      );
    }

    // 只有当 width 是数字类型时才进行 srcSet 优化
    const numericWidth = typeof width === 'number' ? width : undefined;

    // 用户传入的 srcSet 优先，否则生成优化的 srcSet
    const srcSet =
      userSrcSet ??
      buildSrcSet(
        src,
        breakpoints,
        format ?? (defaultFormat as ImageFormat),
        quality,
        numericWidth,
        sizes,
      );

    const baseSrc = applyParamsToUrl(src, {
      resize: numericWidth ? `w_${numericWidth}` : undefined,
      quality: `Q_${quality}`,
      format: format ?? defaultFormat,
    });

    return (
      <img
        {...rest}
        ref={ref}
        src={baseSrc}
        width={width}
        height={height}
        sizes={sizes}
        srcSet={srcSet}
        className={cn(
          'bg-linear-to-b from-gray-50/20 to-gray-200/20',
          className,
        )}
        loading={loading}
        decoding={decoding}
        onError={handleError}
      />
    );
  },
);

Image.displayName = 'Image';

export default Image;
