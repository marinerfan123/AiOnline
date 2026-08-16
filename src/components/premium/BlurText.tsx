import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

type BlurTextTag = 'p' | 'h1' | 'h2' | 'h3' | 'span' | 'div';

interface BlurTextProps {
  /** 按空格分词，逐词模糊入场 */
  text: string;
  className?: string;
  style?: React.CSSProperties;
  as?: BlurTextTag;
}

/**
 * BlurText — 逐词模糊入场。
 * IntersectionObserver 触发（可见 10% 即播放，仅一次）。
 * 每词：blur(10→5→0) / opacity(0→.5→1) / y(50→-5→0)，stagger 100ms。
 */
export function BlurText({ text, className = '', style, as: Tag = 'p' }: BlurTextProps) {
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setInView(true);
            obs.disconnect();
          }
        });
      },
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const words = text.split(' ');
  return (
    <Tag
      ref={ref as never}
      className={className}
      style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', rowGap: '0.1em', ...style }}
    >
      {words.map((word, i) => (
        <motion.span
          key={i}
          style={{ display: 'inline-block', marginRight: '0.28em' }}
          initial={{ filter: 'blur(10px)', opacity: 0, y: 50 }}
          animate={
            inView
              ? {
                  filter: ['blur(10px)', 'blur(5px)', 'blur(0px)'],
                  opacity: [0, 0.5, 1],
                  y: [50, -5, 0],
                }
              : { filter: 'blur(10px)', opacity: 0, y: 50 }
          }
          transition={{ duration: 0.7, times: [0, 0.5, 1], ease: 'easeOut', delay: (i * 100) / 1000 }}
        >
          {word}
        </motion.span>
      ))}
    </Tag>
  );
}

export default BlurText;
