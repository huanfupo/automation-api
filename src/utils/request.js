/**
 * HTTP 请求封装模块（基于 Node 原生 fetch）
 * - 使用 fetch/undici（HTTP/2）可绕过部分 Cloudflare TLS 指纹检测
 * - 自动记录请求/响应日志
 * - 统一错误处理与重试
 */

import logger from '../logger.js';

// 默认超时 30 秒
const DEFAULT_TIMEOUT = 30000;

// 最大重试次数
const MAX_RETRIES = 3;

// 重试间隔（毫秒）
const RETRY_DELAY = 2000;

/**
 * 休眠等待
 * @param {number} ms - 毫秒
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 拼接 URL 与 query 参数
 * @param {string} url
 * @param {object} params
 * @returns {string}
 */
function buildUrl(url, params) {
  if (!params || Object.keys(params).length === 0) {
    return url;
  }
  const qs = new URLSearchParams(params).toString();
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

/**
 * 将 fetch Headers 对象转换为普通对象
 * @param {Headers} headers
 * @returns {object}
 */
function headersToObject(headers) {
  const obj = {};
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

/**
 * 解析响应体（优先 JSON，失败回退为文本）
 * @param {Response} response
 * @returns {Promise<object|string>}
 */
async function parseBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 发送 HTTP 请求
 * @param {object} config - 请求配置
 * @returns {Promise<object>} 响应结果
 */
async function request(config) {
  const startTime = Date.now();
  const { method = 'GET', url, headers = {}, data, params } = config;
  const fullUrl = buildUrl(url, params);

  // 记录请求日志
  logger.info(`→ REQUEST  ${method.toUpperCase()} ${fullUrl}`, {
    headers: sanitizeHeaders(headers),
    body: data,
  });

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout || DEFAULT_TIMEOUT);

    try {
      const response = await fetch(fullUrl, {
        method,
        headers,
        body: data !== undefined ? JSON.stringify(data) : undefined,
        signal: controller.signal,
        // 保持与浏览器一致的 HTTP/2 行为（Node fetch 默认启用）
      });
      clearTimeout(timeoutId);

      const responseData = await parseBody(response);
      const duration = Date.now() - startTime;

      // 记录响应日志
      logger.info(`← RESPONSE ${response.status} ${method.toUpperCase()} ${url}`, {
        status: response.status,
        duration: `${duration}ms`,
        dataLength: JSON.stringify(responseData)?.length,
        attempt,
      });

      // 非 2xx 响应：打印响应体内容，便于定位问题
      if (response.status >= 400) {
        logger.error(
          `← ERROR BODY ${response.status}: ${truncate(JSON.stringify(responseData), 500)}`
        );
      }

      return {
        status: response.status,
        headers: headersToObject(response.headers),
        // 原始 Set-Cookie 列表（多值保留），供调用方维护 cookie 池
        setCookies: response.headers.getSetCookie ? response.headers.getSetCookie() : [],
        data: responseData,
        duration,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      const duration = Date.now() - startTime;

      logger.error(
        `✗ REQUEST ERROR ${method.toUpperCase()} ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        {
          message: err.message,
          code: err.code,
          duration: `${duration}ms`,
          attempt,
        }
      );

      if (attempt < MAX_RETRIES) {
        logger.info(`⏳ 等待 ${RETRY_DELAY}ms 后重试...`);
        await sleep(RETRY_DELAY * attempt); // 递增延迟
      }
    }
  }

  // 所有重试均失败
  throw new Error(
    `请求失败 (已重试 ${MAX_RETRIES} 次): ${config.method} ${config.url} —— ${lastError?.message}`
  );
}

/**
 * 截断长字符串，避免日志过大
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen = 500) {
  if (!str) {
    return str;
  }
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

/**
 * 脱敏 headers（隐藏敏感的 cookie / token 全文）
 * @param {object} headers
 * @returns {object}
 */
function sanitizeHeaders(headers) {
  const safe = { ...headers };
  const sensitiveKeys = ['cookie', 'authorization', 'set-cookie'];

  Object.keys(safe).forEach((key) => {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      const val = safe[key];
      if (typeof val === 'string' && val.length > 20) {
        safe[key] = val.slice(0, 20) + '...[已脱敏]';
      }
    }
  });

  return safe;
}

export { request, sleep };
