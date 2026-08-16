import { type CSSProperties, type ElementType, type ReactNode } from 'react';
import { motion } from 'framer-motion';

interface FadeInOptions {
  y?: number;
  duration?: number;
}

/**
 * fadeIn — 返回可直接展开到 motion.* 的 initial/animate/transition。
 * 通用 blur(10→0) + y + opacity 入场，easeOut，支持错峰 delay。
 */
export function fadeIn(delay = 0, opts?: FadeInOptions) {
  const y = opts?.y ?? 20;
  const duration = opts?.duration ?? 0.6;
  return {
    initial: { filter: 'blur(10px)', opacity: 0, y } as const,
    animate: { filter: 'blur(0px)', opacity: 1, y: 0 } as const,
    transition: { duration, ease: 'easeOut' as const, delay },
  };
}

type FadeInTag = 'div' | 'section' | 'header' | 'p' | 'span' | 'article';

interface FadeInProps {
  children: ReactNode;
  delay?: number;
  y?: number;
  duration?: number;
  className?: string;
  style?: CSSProperties;
  as?: FadeInTag;
}

const motionTags: Record<FadeInTag, ElementType> = {
  div: motion.div,
  section: motion.section,
  header: motion.header,
  p: motion.p,
  span: motion.span,
  article: motion.article,
};

/** FadeIn — 便捷包装组件，套用 fadeIn() 入场动画。 */
export function FadeIn({ children, delay = 0, y = 20, duration = 0.6, className = '', style, as = 'div' }: FadeInProps) {
  const m = fadeIn(delay, { y, duration });
  const MotionTag = motionTags[as];
  return (
    <MotionTag className={className} style={style} initial={m.initial} animate={m.animate} transition={m.transition}>
      {children}
    </MotionTag>
  );
}

export default FadeIn;
