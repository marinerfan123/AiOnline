import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation } from "react-router-dom";
import App from "./app";
import { initAuth } from "./services/authStore";
import "./index.css";

// 启动即尝试恢复会话（有 cookie 则拿到登录用户，否则 user=null，不阻塞渲染）
void initAuth();

// 关闭浏览器自动恢复滚动位置（避免刷新后回到上次浏览的位置）
// 改由下面的 ScrollToTopOnRoute 显式控制：每次 pathname 变化时滚到顶。
if ("scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

// 路由级回顶组件：pathname 一变就 scrollTo(0,0)。
// 解决「刷新或重进当页面 → 应回到初始状态」的需求，配合 ModelHubPage 内的 key={activeTab} 重挂载，
// 既清掉组件 local state（编辑草稿、筛选条件、临时输入），也清掉浏览器的滚动位置。
function ScrollToTopOnRoute() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ScrollToTopOnRoute />
      <App />
    </BrowserRouter>
  </StrictMode>,
);
