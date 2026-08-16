import { useEffect, useRef, useState } from 'react';

interface UseInViewOptions {
  /** 视口扩展边距，默认 '200px'（提前 200px 开始加载） */
  rootMargin?: string;
  /** 交叉比例阈值，默认 0 */
  threshold?: number;
  /** 进入视口后是否保持 true，默认 true */
  triggerOnce?: boolean;
}

/**
 * IntersectionObserver 封装：检测元素是否进入视口。
 * 用于图片墙懒加载、无限滚动等场景。
 */
export function useInView<T extends HTMLElement = HTMLDivElement>(
  options: UseInViewOptions = {},
) {
  const { rootMargin = '200px', threshold = 0, triggerOnce = true } = options;
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (triggerOnce && inView) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (triggerOnce) observer.disconnect();
        } else if (!triggerOnce) {
          setInView(false);
        }
      },
      { rootMargin, threshold },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin, threshold, triggerOnce, inView]);

  return { ref, inView };
}
