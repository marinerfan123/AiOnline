// 顶层 ErrorBoundary：捕获任意 React 组件 / 生命周期 / setTimeout 回调抛出的同步错误，
// 防止整个 SPA 子树被卸载（避免"图自动消失"类同步崩溃放大成整页空白）。
// 触发后展示"刷新页面"按钮和错误摘要，开发态显示完整 stack 便于排查。
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 自定义回退 UI；不传则用内置默认 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 把错误日志留给浏览器 / 上报系统，不阻断回退 UI
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] caught:', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-zinc-950 px-6 text-center">
        <div className="text-6xl">⚠️</div>
        <h1 className="text-xl font-semibold text-white">页面遇到了一个意外错误</h1>
        <p className="max-w-md text-sm text-zinc-400">
          我们已经捕获到了这个问题。点击下方按钮刷新页面即可恢复。
        </p>
        <pre className="max-w-2xl overflow-auto rounded-lg bg-zinc-900/80 p-3 text-left text-[11px] text-zinc-500 ring-1 ring-zinc-800">
          {error.message}
          {import.meta.env.DEV && error.stack ? '\n\n' + error.stack : ''}
        </pre>
        <button
          onClick={this.reset}
          className="mt-2 inline-flex items-center gap-2 rounded-full bg-emerald-500 px-5 py-2.5 text-sm font-bold text-black shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 active:scale-95 transition-all duration-200"
        >
          🔄 刷新页面
        </button>
      </div>
    );
  }
}
