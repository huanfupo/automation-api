/**
 * 验证码打码服务模块（capsolver / 2captcha / yescaptcha，支持双服务商混合）
 * 用途：自动化获取 verify_magic_link 所需的两个验证码 token
 *  - arkose_session_token：Arkose/FunCaptcha（publicKey 为 Claude 站点固定值）
 *  - hcaptcha_token：hCaptcha（sitekey 自动从 Magic Link 页面提取，可用 .env 覆盖）
 *
 * 混合方案说明（实测最优）:
 *  - yescaptcha 解 hCaptcha 秒解（~18s），但不支持 Arkose
 *  - 2captcha 解 Arkose 秒解（~5s），但 hCaptcha 成功率低（~14%）
 *  - 因此 hCaptcha 走 CAPTCHA_PROVIDER，Arkose 可独立走 ARKOSE_PROVIDER
 *
 * 配置（.env）：
 *  - CAPTCHA_PROVIDER=capsolver（默认）| 2captcha | yescaptcha（hCaptcha 服务商）
 *  - CAPTCHA_PROVIDER_KEY=xxx（必填，hCaptcha 服务商 API Key）
 *  - ARKOSE_PROVIDER=xxx（可选，Arkose 服务商，默认同 CAPTCHA_PROVIDER）
 *  - ARKOSE_PROVIDER_KEY=xxx（可选，Arkose API Key，默认同 CAPTCHA_PROVIDER_KEY）
 *  - HCAPTCHA_SITEKEY=xxx（可选，页面提取失败时兜底）
 *  - CAPTCHA_TASK_TIMEOUT_MS=180000（可选，单任务超时）
 */

import logger from '../logger.js';
import { request, sleep } from '../utils/request.js';

const PROVIDER = process.env.CAPTCHA_PROVIDER || 'capsolver';
const API_KEY = process.env.CAPTCHA_PROVIDER_KEY || '';
// Arkose 可独立指定服务商（yescaptcha 不支持 Arkose 时，用 2captcha 解）
const ARKOSE_PROVIDER = process.env.ARKOSE_PROVIDER || PROVIDER;
const ARKOSE_API_KEY = process.env.ARKOSE_PROVIDER_KEY || API_KEY;
const HCAPTCHA_SITEKEY_OVERRIDE = process.env.HCAPTCHA_SITEKEY || '';
// 实测 hCaptcha 任务可能耗时 3-5 分钟甚至偶发无解（ERROR_CAPTCHA_UNSOLVABLE），
// 因此单任务超时给足余量，并支持失败后自动重试
const TASK_TIMEOUT_MS = Number(process.env.CAPTCHA_TASK_TIMEOUT_MS) || 600000;
const TASK_RETRIES = Number(process.env.CAPTCHA_TASK_RETRIES) || 3; // 失败/超时后重试次数
const POLL_INTERVAL_MS = 3000;

// Claude 站点在 Arkose 平台的固定公钥（从真实抓包 token 中解析得到）
const ARKOSE_PUBLIC_KEY = 'EEA5F558-D6AC-4C03-B678-AABF639EE69A';
const WEBSITE_URL = 'https://claude.ai';
// 打码服务解出的 token 会绑定提交时的浏览器环境（UA/指纹），
// 必须与 verify_magic_link 请求头 UA 完全一致，否则服务端 400 拒绝（实测）
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/**
 * 服务商适配器：任务构建与结果提取差异
 */
const PROVIDERS = {
  capsolver: {
    name: 'capsolver',
    createUrl: 'https://api.capsolver.com/createTask',
    resultUrl: 'https://api.capsolver.com/getTaskResult',
    buildArkoseTask() {
      return {
        type: 'ArkoseTask',
        websiteURL: WEBSITE_URL,
        publicKey: ARKOSE_PUBLIC_KEY,
        userAgent: BROWSER_UA,
      };
    },
    buildHcaptchaTask(sitekey) {
      return {
        type: 'HCaptchaTaskProxyLess',
        websiteURL: WEBSITE_URL,
        websiteKey: sitekey,
        userAgent: BROWSER_UA,
      };
    },
    extractToken(solution = {}) {
      return solution.gRecaptchaResponse || solution.token || solution.arkose_session_token || null;
    },
  },
  '2captcha': {
    name: '2captcha',
    createUrl: 'https://api.2captcha.com/createTask',
    resultUrl: 'https://api.2captcha.com/getTaskResult',
    // 2captcha createTask 缺少 softId 时会误报 ERROR_TASK_ABSENT，必须带上（4583 为其官方示例 ID）
    softId: 4583,
    buildArkoseTask() {
      return {
        // 注意：2captcha 任务类型名为 FunCaptchaTaskProxyless（capsolver 才是 FunCaptchaTaskProxyLess）
        type: 'FunCaptchaTaskProxyless',
        websiteURL: WEBSITE_URL,
        websitePublicKey: ARKOSE_PUBLIC_KEY,
        userAgent: BROWSER_UA,
      };
    },
    buildHcaptchaTask(sitekey) {
      return {
        // 注意：2captcha 任务类型名为 HCaptchaTaskProxyless（capsolver 才是 HCaptchaTaskProxyLess）
        type: 'HCaptchaTaskProxyless',
        websiteURL: WEBSITE_URL,
        websiteKey: sitekey,
        userAgent: BROWSER_UA,
      };
    },
    extractToken(solution = {}) {
      return solution.token || solution.gRecaptchaResponse || null;
    },
  },
  yescaptcha: {
    name: 'yescaptcha',
    createUrl: 'https://api.yescaptcha.com/createTask',
    resultUrl: 'https://api.yescaptcha.com/getTaskResult',
    // yescaptcha 已停止支持 FunCaptcha 协议任务（文档标记 [已不支持]，实测 ERROR_TASK_NOT_SUPPORTED），
    // 因此仅支持 hCaptcha；Arkose 需通过 ARKOSE_PROVIDER 独立指定（如 2captcha）
    supportsArkose: false,
    buildArkoseTask() {
      throw new Error(
        'yescaptcha 不支持 Arkose/FunCaptcha 任务，请配置 ARKOSE_PROVIDER 使用其他服务商'
      );
    },
    buildHcaptchaTask(sitekey) {
      // 实测：HCaptchaTaskProxyless 对 Claude enterprise hCaptcha 秒解（返回 P1_ token + E1_ respKey）
      return {
        type: 'HCaptchaTaskProxyless',
        websiteURL: WEBSITE_URL,
        websiteKey: sitekey,
        userAgent: BROWSER_UA,
      };
    },
    extractToken(solution = {}) {
      return solution.gRecaptchaResponse || solution.token || null;
    },
  },
};

/**
 * 创建打码任务
 * @param {object} task - 任务描述（type/websiteURL/sitekey 等）
 * @param {object} provider - 服务商适配器
 * @param {string} apiKey - 对应服务商 API Key
 * @returns {Promise<string>} taskId
 */
async function createTask(task, provider, apiKey) {
  const data = { clientKey: apiKey, task };
  if (provider.softId) {
    data.softId = provider.softId;
  }
  const res = await request({
    method: 'POST',
    url: provider.createUrl,
    headers: { 'Content-Type': 'application/json' },
    data,
  });

  if (res.status !== 200 || !res.data?.taskId) {
    throw new Error(
      `创建打码任务失败: HTTP ${res.status} —— ${JSON.stringify(res.data)?.slice(0, 200)}`
    );
  }
  return res.data.taskId;
}

/**
 * 轮询等待任务完成
 * @param {string} taskId
 * @param {object} provider - 服务商适配器
 * @param {string} apiKey - 对应服务商 API Key
 * @returns {Promise<object>} solution
 */
async function waitTaskResult(taskId, provider, apiKey) {
  const deadline = Date.now() + TASK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await request({
      method: 'POST',
      url: provider.resultUrl,
      headers: { 'Content-Type': 'application/json' },
      data: { clientKey: apiKey, taskId },
    });

    const { status, solution, errorCode, errorDescription } = res.data || {};

    if (status === 'ready') {
      return solution || {};
    }
    if (status === 'failed' || errorCode) {
      throw new Error(`打码任务失败: ${errorCode || status} —— ${errorDescription || ''}`);
    }
    // status === 'processing'：继续轮询
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`打码任务超时（${TASK_TIMEOUT_MS}ms）: taskId=${taskId}`);
}

/**
 * 解析单个验证码任务，返回 token
 * @param {object} task - 任务描述
 * @param {string} label - 日志标签（如 Arkose / hCaptcha）
 * @param {object} provider - 服务商适配器
 * @param {string} apiKey - 对应服务商 API Key
 * @returns {Promise<string>} token
 */
async function solveOne(task, label, provider, apiKey) {
  let lastError;

  for (let attempt = 1; attempt <= TASK_RETRIES + 1; attempt++) {
    try {
      logger.info(`🧩 创建${label}打码任务（${provider.name}，第 ${attempt} 次尝试）...`);
      const taskId = await createTask(task, provider, apiKey);
      logger.info(`🧩 ${label}任务已创建: ${taskId}`);

      const solution = await waitTaskResult(taskId, provider, apiKey);
      const token = provider.extractToken(solution);
      if (!token) {
        throw new Error(
          `${label}任务完成但未返回 token: ${JSON.stringify(solution)?.slice(0, 200)}`
        );
      }
      return token;
    } catch (err) {
      lastError = err;
      if (attempt <= TASK_RETRIES) {
        // 实测 2captcha hCaptcha 任务可能耗时超过 3 分钟或偶发无解，重试可显著提高成功率
        logger.warn(`⚠️ ${label}打码任务第 ${attempt} 次失败（${err.message}），稍后自动重试...`);
        await sleep(POLL_INTERVAL_MS * 2);
      }
    }
  }

  throw new Error(
    `${label}打码任务重试 ${TASK_RETRIES + 1} 次仍失败，最后一次错误: ${lastError?.message}`
  );
}

/**
 * 从 Magic Link 页面 HTML 提取 hCaptcha sitekey
 * 优先使用 .env 的 HCAPTCHA_SITEKEY；否则 GET 页面源码正则匹配
 * @param {string} magicLink
 * @returns {Promise<string>}
 */
async function extractHcaptchaSitekey(magicLink) {
  if (HCAPTCHA_SITEKEY_OVERRIDE) {
    logger.info(`🔑 使用 .env 配置的 hCaptcha sitekey: ${HCAPTCHA_SITEKEY_OVERRIDE}`);
    return HCAPTCHA_SITEKEY_OVERRIDE;
  }

  // hash 不会发送到服务器，直接 GET 页面源码
  const res = await request({
    method: 'GET',
    url: magicLink,
    headers: { 'Content-Type': 'text/html' },
    timeout: 15000,
  });

  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  const patterns = [
    /data-sitekey=["']([a-zA-Z0-9-]{20,40})["']/,
    /sitekey[=:]["']?([a-zA-Z0-9-]{20,40})/,
    /hcaptcha\.com[^"']*sitekey=([a-zA-Z0-9-]{20,40})/,
  ];

  for (const pattern of patterns) {
    const match = html?.match(pattern);
    if (match?.[1]) {
      logger.info(`🔑 从页面自动提取 hCaptcha sitekey: ${match[1]}`);
      return match[1];
    }
  }

  // claude.ai 页面需执行 JS 才能拿到真实 HTML（fetch 会被 Cloudflare 403），
  // sitekey 为站点级固定值，只需在浏览器中获取一次后配置到 .env
  throw new Error(
    '无法自动提取 hCaptcha sitekey（claude.ai 页面需浏览器 JS 渲染）。' +
      '请手动获取一次并配置 HCAPTCHA_SITEKEY：' +
      '浏览器打开 Magic Link → F12 → Elements 搜索 "sitekey"（或 Network 筛选 hcaptcha，' +
      'iframe src / 请求 URL 中的 sitekey= 参数即为固定值）' +
      '→ 填入 .env 后重新运行'
  );
}

/**
 * 自动化获取验证码 token（先 hCaptcha 后 Arkose，串行）
 * 顺序说明：两 token 均分钟级短时效，且实测 Arkose 秒级即可完成、
 * hCaptcha 可能需要更久；若并行，Arkose token 先到手会过期，
 * 因此先解 hCaptcha，成功后再解 Arkose，两者都是新鲜 token
 * @param {string} magicLink - Magic Link 地址
 * @returns {Promise<{ arkoseSessionToken: string, hcaptchaToken: string }>}
 */
async function solveVerificationTokens(magicLink) {
  if (!API_KEY) {
    throw new Error('未配置 CAPTCHA_PROVIDER_KEY，无法使用打码服务');
  }
  if (!PROVIDERS[PROVIDER]) {
    throw new Error(`不支持的打码服务商: ${PROVIDER}（可选 capsolver / 2captcha / yescaptcha）`);
  }
  if (!PROVIDERS[ARKOSE_PROVIDER]) {
    throw new Error(
      `不支持的 Arkose 服务商: ${ARKOSE_PROVIDER}（可选 capsolver / 2captcha / yescaptcha）`
    );
  }

  const provider = PROVIDERS[PROVIDER];
  const arkoseProvider = PROVIDERS[ARKOSE_PROVIDER];
  const sitekey = await extractHcaptchaSitekey(magicLink);

  // 先解 hCaptcha（难点），成功后再解 Arkose（快且稳定）
  const hcaptchaToken = await solveOne(
    provider.buildHcaptchaTask(sitekey),
    'hCaptcha',
    provider,
    API_KEY
  );

  // yescaptcha 不支持 Arkose 任务：通过 ARKOSE_PROVIDER 使用独立服务商（如 2captcha）
  const arkoseSessionToken = await solveOne(
    arkoseProvider.buildArkoseTask(),
    'Arkose',
    arkoseProvider,
    ARKOSE_API_KEY
  );

  logger.info('✅ 打码服务 token 获取成功（arkose + hCaptcha）');
  return { arkoseSessionToken, hcaptchaToken };
}

export { solveVerificationTokens, extractHcaptchaSitekey };
