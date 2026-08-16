import { type CSSProperties, type ElementType, type ReactNode } from 'react';

interface LiquidGlassProps {
  /** 渲染的标签，默认 div */
  as?: ElementType;
  /** 强玻璃（更重模糊，用于主 CTA） */
  strong?: boolean;
  className?: string;
  children?: ReactNode;
  style?: CSSProperties;
  [key: string]: unknown;
}

/**
 * 液体玻璃容器：套用 .liquid-glass / .liquid-glass-strong。
 * 其余 props（onClick、id 等）透传到底层标签。
 */
export function LiquidGlass({
  as = 'div',
  strong = false,
  className = '',
  children,
  style,
  ...rest
}: LiquidGlassProps) {
  const Tag = as as ElementType;
  return (
    <Tag
      className={`${strong ? 'liquid-glass-strong' : 'liquid-glass'} ${className}`.trim()}
      style={style}
      {...(rest as Record<string, unknown>)}
    >
      {children}
    </Tag>
  );
}

export default LiquidGlass;
