// cURL 命令解析器 —— 把 `curl -X POST 'url' -H 'x: y' -d '{...}'` 解析成结构化数据
// 支持：Bash（单引号/双引号）、Windows CMD/PowerShell、flags without dashes

export interface ParsedCurl {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
}

export function parseCurl(input: string): ParsedCurl | null {
  if (!input || !input.trim().toLowerCase().startsWith('curl')) return null;

  // 1. 去掉开头的 curl 和换行符
  let s = input.trim();
  // 兼容 `curl -X POST ...` 和 `curl 'url' ...`
  s = s.replace(/^curl\s+/i, '');

  // 2. 提取 URL（第一个无 dash 的非 flag 参数，可能是带引号的）
  // 兼容 Windows 行尾 \ 反斜杠续行
  const tokens = tokenizeCurl(s);
  let url = '';
  let method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'POST';
  const headers: Record<string, string> = {};
  let body: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '-X' || tok === '--request') {
      method = (tokens[++i] || 'POST').toUpperCase() as any;
    } else if (tok === '-H' || tok === '--header') {
      const h = tokens[++i] || '';
      const idx = h.indexOf(':');
      if (idx > 0) {
        headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      }
    } else if (tok === '-d' || tok === '--data' || tok === '--data-raw' || tok === '--data-binary') {
      body = tokens[++i];
      if (!method || method === 'GET') method = 'POST';
    } else if (tok === '-u' || tok === '--user') {
      headers['Authorization'] = `Basic ${btoa(tokens[++i] || '')}`;
    } else if (tok === '--url') {
      url = tokens[++i] || '';
    } else if (tok.startsWith('-')) {
      // 跳过其他 flag（可能后跟值）
      // 但有些 flag 是 boolean 不取参数
      continue;
    } else if (!url) {
      // 第一个非 flag token 视为 URL
      url = tok;
    }
  }

  if (!url) return null;
  return { url, method, headers, body };
}

function tokenizeCurl(s: string): string[] {
  // 处理反斜杠续行（Windows 风格）
  s = s.replace(/\\\r?\n/g, ' ');
  s = s.replace(/\\\n/g, ' ');

  const tokens: string[] = [];
  let i = 0;
  const len = s.length;

  while (i < len) {
    // 跳过空白
    while (i < len && /\s/.test(s[i])) i++;
    if (i >= len) break;

    let tok = '';
    const quote = s[i];
    if (quote === '"' || quote === "'") {
      // 引号字符串
      i++;
      while (i < len && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < len) {
          tok += s[i + 1];
          i += 2;
        } else {
          tok += s[i++];
        }
      }
      i++; // 跳过结束引号
    } else {
      // 非引号 token（直到下一个空白）
      while (i < len && !/\s/.test(s[i])) {
        tok += s[i++];
      }
    }
    tokens.push(tok);
  }

  return tokens;
}

// 例子：
// parseCurl(`curl -X POST 'https://api.example.com/v1/images/generations' -H 'Authorization: Bearer xxx' -H 'Content-Type: application/json' -d '{"model":"dall-e-3","prompt":"a cat","n":1}'`)