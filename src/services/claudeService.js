/**
 * Claude 注册服务模块
 * - 验证邮箱是否可用
 * - 发送 magic link 进行注册
 */

import { request } from '../utils/request.js';
import logger from '../logger.js';

const CLAUDE_BASE_URL = 'https://claude.ai/api/auth';

/**
 * Claude 登录 Cookie 配置（变量维护区）
 *
 * 维护方式：浏览器 F12 → Application → Cookies → claude.ai，
 * 更新对应 name 的 value 后保存即可，无需改其它代码。
 *
 * 字段说明：
 * - name  Cookie 名
 * - value Cookie 值（更新时替换这里）
 * - note  用途/来源说明
 * - ttl   时效性：short=分钟级（核心，过期必刷） / session=会话级 / long=持久
 *
 * 生成规则：
 * - cf_clearance / __cf_bm / _cfuvid 由 Cloudflare 服务端签名，
 *   含 unix 时间戳（生成时刻），绑定 UA+IP，无法代码伪造，只能抓包
 * - g_state / _dd_s 含毫秒时间戳（created/expire/i_ll/i_et），随访问刷新
 * - anthropic-device-id / ajs_anonymous_id / __fbp / _gcl_au 为持久设备标识
 */
const CLAUDE_COOKIE_CONFIG = [
  // ── Cloudflare 反爬凭证（short，过期后需重新抓包）──
  {
    name: 'cf_clearance',
    value:
      '1dO8b7gjQhPD4TDVfpVy0kScl2gD8hksFqptWE2KKhg-1785574812-1.2.1.1-BlVf0OGLs0nm2PkUeDYyMtwmK6lfnojfdMMnCqVkxTUpxLgl2UszQToZyftTdRDVOgWtO7PT_t8Op83_empMWbat.uiCTY1km1bJqRqwPgk4f46KvzF4DCXNR0AXDAsCMJLPbVwPx6BLiD.1u05PGVS7Zi_Jh8fUgIbMxfcvcnj3ki8dmoPuqA.AqYzL7H4VjtCbhf9Ex.7kqjqVr8IN8lhqAsbPCECLcfpzMzLWhP6AlIllyulAHaSqoxSmaL8fbh7d.3pbUSL16p2pFGD7MFW6uFEfNMrkvKZ9OUOXGqq1HAfYPMqEtKWTZaB_h06yyKB7.UkjT1WTndrpLuXROpZfj.D5uiP9XvYA1AZPJW4',
    note: 'Cloudflare 验证凭证（绑定 UA/IP）',
    ttl: 'short',
  },
  {
    name: '__cf_bm',
    value:
      'Q9JwSSeY5iIaXMBzFfIXzrJKnxgW.NhDZYWUVG6nHg0-1785574812.3794715-1.0.1.1-EUldRnNUzctNp4suDRsgQ4Ii6ci_QARXtHh8jumuuIKtFDaR7xK95pfkLBuk27zoA6SWLnnS5PE7JyZuvXiU0rM4TaIqmStYxuOgxNiZD1o6j9Ma_3TM4sfgSiOcPWpy',
    note: 'Cloudflare 机器人管理指纹',
    ttl: 'short',
  },
  {
    name: '_cfuvid',
    value:
      'JdKrdpYZEtEenHntST4ILjFHatA25ep2qV4f5M1xQWk-1785574810.845603-1.0.1.1-KzR48jvMf74TZCPND86GOaOaZTwUcmUKtu8vMcIW0R0',
    note: 'Cloudflare 访客唯一 ID',
    ttl: 'short',
  },
  // ── 设备与匿名标识（long，一般无需更新）──
  {
    name: 'anthropic-device-id',
    value: 'a42739a2-79f8-47d1-9438-48974408df58',
    note: '设备唯一标识 UUID',
    ttl: 'long',
  },
  {
    name: 'ajs_anonymous_id',
    value: 'claudeai.v1.bf1f0ed7-8a96-4c06-8829-0f0675774842',
    note: 'Segment 分析匿名 ID',
    ttl: 'long',
  },
  {
    name: '__fbp',
    value: 'fb.1.1785574810855.80973582507674160',
    note: 'Meta Pixel 追踪',
    ttl: 'long',
  },
  {
    name: 'CH-prefers-color-scheme',
    value: 'light',
    note: '主题偏好',
    ttl: 'long',
  },
  {
    name: 'anthropic-epitaxy-icon-font',
    value: '1',
    note: '图标字体加载标记',
    ttl: 'long',
  },
  // ── 会话与状态（session，随会话刷新）──
  {
    name: 'activitySessionId',
    value: 'e6c4c7bb-b82c-4a08-b4aa-44f5d9a53de0',
    note: '活动会话 ID UUID',
    ttl: 'session',
  },
  {
    name: 'ion-vk',
    value: 'a344eb6b-f131-4a03-983b-aa54efc5823c',
    note: '前端交互框架密钥',
    ttl: 'session',
  },
  {
    name: 'g_state',
    value:
      '{"i_l":0,"i_ll":1785574974183,"i_b":"2yhr/CiVUV3k1SsPhqS3dYGu5rzZh2krS28c6jprZic","i_e":{"enable_itp_optimization":24},"i_et":1785574974183}',
    note: 'Google Identity 状态（含时间戳）',
    ttl: 'session',
  },
  {
    name: '_dd_s',
    value:
      'aid=423443b2-781e-42f5-b9c4-4f2e0c4c156a&rum=2&id=c3c15445-289b-4660-9ab3-78c830009430&created=1785574810292&expire=1785575907440',
    note: 'Datadog RUM 会话（含时间戳）',
    ttl: 'session',
  },
];

// 整体覆盖：可在 .env 中设置 CLAUDE_COOKIE（完整 cookie 串）一键替换
const CLAUDE_COOKIE_OVERRIDE = process.env.CLAUDE_COOKIE;

/**
 * 动态 Cookie 池（启动时自动探测获取，动态值优先于静态配置）
 * 说明：cf_clearance 仅在触发 Cloudflare 挑战后才下发，
 * 而 fetch（HTTP/2）可直接通过初始检测，故无需 cf_clearance；
 * 实际会自动获取 __cf_bm / _cfuvid 等每次会话刷新的凭证。
 */
const dynamicCookies = {};

/**
 * 从响应 Set-Cookie 中回填动态 cookie 池
 * @param {string[]} setCookies - request() 返回的 setCookies 数组
 */
function applySetCookies(setCookies) {
  for (const raw of setCookies || []) {
    const pair = raw.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    // 仅回填 Cloudflare 会话级凭证，避免覆盖持久标识
    if (['__cf_bm', '_cfuvid', '_fbp', 'anthropic-device-id', 'activitySessionId'].includes(name)) {
      dynamicCookies[name] = value;
    }
  }
}

/**
 * 启动时自动获取 Cloudflare 反爬凭证（每次启动调用一次）
 * 通过探测 login_methods 接口，响应 Set-Cookie 会下发最新 __cf_bm / _cfuvid
 * 失败不抛错，回退使用静态配置
 * @returns {Promise<void>}
 */
async function refreshCloudflareCookies() {
  logger.info('🔄 正在自动获取 Cloudflare 反爬凭证（__cf_bm / _cfuvid）...');
  try {
    const res = await request({
      method: 'GET',
      url: `${CLAUDE_BASE_URL}/login_methods`,
      // 首次探测不带 Cookie，获取服务端下发的初始凭证
      headers: { ...BROWSER_HEADERS },
      params: { email: 'cloudflare-probe@chaip.app', source: 'claude-ai' },
    });

    if (res.status !== 200) {
      logger.warn(`⚠️ 凭证探测响应异常: HTTP ${res.status}，继续使用静态配置`);
      return;
    }

    applySetCookies(res.setCookies);
    const acquired = Object.keys(dynamicCookies).filter((k) => ['__cf_bm', '_cfuvid'].includes(k));

    if (acquired.length > 0) {
      logger.info(`✅ Cloudflare 凭证自动获取成功: ${acquired.join(', ')}`);
    } else {
      logger.warn('⚠️ 响应未下发 Cloudflare 凭证，继续使用静态配置');
    }
  } catch (err) {
    logger.warn(`⚠️ Cloudflare 凭证自动获取失败: ${err.message}，继续使用静态配置`);
  }
}

/**
 * Claude 浏览器 headers 配置（变量维护区）
 *
 * 维护方式：按分组修改对应项的 value 即可，无需改动其它代码。
 * 每项：name=请求头名 / value=值 / note=用途说明
 *
 * 分组说明：
 * - 基础：请求类型与来源标识（UA/Origin/Referer 用于通过同源校验）
 * - Client Hints：Chrome 结构化 UA 提示，需与 User-Agent 版本一致
 * - Fetch 元数据：浏览器安全机制要求，缺省会触发 CORS/CSRF 校验失败
 * - Datadog：RUM 链路追踪（Traceparent 与 X-Datadog-* 关联）
 * - 会话：X-activity-session-id 需与 Cookie 中 activitySessionId 对应
 */
const BROWSER_HEADER_CONFIG = [
  // ── 基础请求头 ──
  { name: 'Accept', value: '*/*', note: '接受任意响应类型' },
  {
    name: 'Accept-Language',
    value: 'zh-CN,zh;q=0.9,en;q=0.8',
    note: '语言偏好',
  },
  { name: 'Content-Type', value: 'application/json', note: 'JSON 请求体类型' },
  { name: 'Origin', value: 'https://claude.ai/login', note: '来源页面（同源校验）' },
  { name: 'Referer', value: 'https://claude.ai/login', note: '来源页地址' },
  {
    name: 'User-Agent',
    value:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    note: 'Chrome 151 Windows',
  },
  // ── Client Hints（Chrome 客户端提示，与 UA 版本一致）──
  {
    name: 'Sec-Ch-Ua',
    value: '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
    note: '结构化 UA 品牌列表',
  },
  { name: 'Sec-Ch-Ua-Arch', value: 'x86', note: 'CPU 架构' },
  { name: 'Sec-Ch-Ua-Bitness', value: '64', note: '系统位数' },
  { name: 'Sec-Ch-Ua-Full-Version', value: '151.0.7922.72', note: 'Chrome 完整版本' },
  {
    name: 'Sec-Ch-Ua-Full-Version-List',
    value:
      '"Not=A?Brand";v="99.0.0.0", "Google Chrome";v="151.0.7922.72", "Chromium";v="151.0.7922.72"',
    note: '品牌完整版本列表',
  },
  { name: 'Sec-Ch-Ua-Mobile', value: '?0', note: '非移动端' },
  { name: 'Sec-Ch-Ua-Model', value: '', note: '设备型号（桌面端为空）' },
  { name: 'Sec-Ch-Ua-Platform', value: 'Windows', note: '操作系统' },
  { name: 'Sec-Ch-Ua-Platform-Version', value: '19.0.0', note: '系统版本' },
  // ── Fetch 元数据（浏览器安全机制）──
  { name: 'Sec-Fetch-Dest', value: 'empty', note: '请求目标类型' },
  { name: 'Sec-Fetch-Mode', value: 'cors', note: '跨域模式' },
  { name: 'Sec-Fetch-Site', value: 'same-origin', note: '同源请求' },
  // ── Datadog RUM 链路追踪 ──
  {
    name: 'Traceparent',
    value: '00-00000000000000005368884ba51a9827-3cb36fd67b4be537-01',
    note: 'W3C 链路追踪（关联 Datadog）',
  },
  { name: 'Tracestate', value: 'dd=s:1;o:rum', note: '追踪状态（Datadog）' },
  {
    name: 'X-Datadog-Parent-Id',
    value: '4373962630089139511',
    note: 'Datadog 父节点 ID',
  },
  { name: 'X-Datadog-Sampling-Priority', value: '1', note: '采样优先级' },
  { name: 'X-Datadog-Trace-Id', value: '6010203561199835175', note: 'Datadog 追踪 ID' },
  // ── 会话相关 ──
  {
    name: 'X-activity-session-id',
    value: '03fcf801-7e17-45b8-adfc-60494b2e7da1',
    note: '活动会话 ID（对应 Cookie activitySessionId）',
  },
];

/** 由配置数组自动构建的请求头对象（供请求直接展开使用） */
const BROWSER_HEADERS = Object.fromEntries(BROWSER_HEADER_CONFIG.map((h) => [h.name, h.value]));

/**
 * 步骤 1：验证邮箱地址（检查是否可用）
 * @param {string} email - 邮箱地址
 * @returns {Promise<object>}
 */
async function checkEmailAvailability(email) {
  logger.info(`🔎 检查邮箱是否可用: ${email}`);

  const res = await request({
    method: 'GET',
    url: `${CLAUDE_BASE_URL}/login_methods`,
    headers: {
      ...BROWSER_HEADERS,
      Cookie: buildClaudeCookie(),
    },
    params: {
      email,
      source: 'claude-ai',
    },
  });

  logger.info(`邮箱验证结果: HTTP ${res.status}`);
  return res.data;
}

/**
 * 步骤 2：发送 magic link 验证邮件
 * @param {string} email - 邮箱地址
 * @param {number} utcOffset - UTC 偏移量（默认 -480 即 UTC+8）
 * @returns {Promise<object>}
 */
async function sendMagicLink(email, utcOffset = -480) {
  logger.info(`📨 发送 Magic Link 到: ${email}`);

  const res = await request({
    method: 'POST',
    url: `${CLAUDE_BASE_URL}/send_magic_link`,
    headers: {
      ...BROWSER_HEADERS,
      Cookie: buildClaudeCookie(),
    },
    data: {
      utc_offset: utcOffset,
      email_address: email,
      login_intent: null,
      locale: 'en-US',
      return_to: null,
      source: 'claude',
    },
  });

  if (res.status !== 200) {
    throw new Error(`发送 Magic Link 失败: HTTP ${res.status} —— ${JSON.stringify(res.data)}`);
  }

  logger.info(`✅ Magic Link 发送成功: ${res.data?.message || 'OK'}`);
  return res.data;
}

/**
 * 步骤 3.5：用 nonce 换取验证码 code（Claude 新流程，必须先 exchange 再 verify）
 * 接口：POST /api/auth/exchange_nonce_for_code
 * @param {string} nonce - Magic Link hash 中的 nonce（# 后第一段）
 * @param {string} encodedEmail - Magic Link hash 中的 base64 编码邮箱（# 后第二段）
 * @returns {Promise<string>} 验证码 code
 */
async function exchangeNonceForCode(nonce, encodedEmail) {
  logger.info(`🔑 交换 nonce 获取验证码（nonce: ${nonce.slice(0, 8)}...）`);

  const res = await request({
    method: 'POST',
    url: `${CLAUDE_BASE_URL}/exchange_nonce_for_code`,
    headers: {
      ...BROWSER_HEADERS,
      Cookie: buildClaudeCookie(),
    },
    data: {
      nonce,
      encoded_email_address: encodedEmail,
      source: 'claude',
    },
  });

  if (res.status !== 200 || !res.data?.code) {
    throw new Error(
      `交换验证码失败: HTTP ${res.status} —— ${JSON.stringify(res.data)?.slice(0, 200)}`
    );
  }

  logger.info(`✅ 验证码获取成功: ${res.data.code}`);
  return res.data.code;
}

/**
 * 步骤 3：验证 Magic Link，完成账号创建/登录
 * 接口：POST /api/auth/verify_magic_link（先 exchange_nonce_for_code 换 code，再以 code 方式提交）
 * 注意：arkose_session_token 与 hcaptcha_token 为验证码挑战 token，
 *       需从真实浏览器 Network 面板或验证码打码服务获取，不可伪造
 * @param {string} magicLink - 如 https://claude.ai/magic-link#<nonce>:<encoded_email>
 * @param {object} [tokens] - 验证码 token
 * @param {string} [tokens.arkoseSessionToken] - Arkose/FunCaptcha 会话 token
 * @param {string} [tokens.hcaptchaToken] - hCaptcha 挑战 token
 * @returns {Promise<object>} 账号信息 { account, created, ... }
 */
async function verifyMagicLink(magicLink, tokens = {}) {
  const { nonce, encodedEmail } = parseMagicLink(magicLink);
  logger.info(`🔑 验证 Magic Link（nonce: ${nonce.slice(0, 8)}...）`);

  // 1. 先用 nonce 换取验证码 code（Claude 新流程）
  const code = await exchangeNonceForCode(nonce, encodedEmail);
  // email_address 必须是明文邮箱（base64 会被拒绝: value is not a valid email address）
  const emailAddress = Buffer.from(encodedEmail, 'base64').toString('utf8');

  // 2. 以 code + 双 token 提交验证
  const res = await request({
    method: 'POST',
    url: `${CLAUDE_BASE_URL}/verify_magic_link`,
    headers: {
      ...BROWSER_HEADERS,
      Cookie: buildClaudeCookie(),
    },
    data: {
      credentials: {
        method: 'code',
        email_address: emailAddress,
        code,
      },
      locale: 'en-US',
      arkose_session_token: tokens.arkoseSessionToken || null,
      client_attestation: {
        hcaptcha_token: tokens.hcaptchaToken || null,
      },
      source: 'claude',
    },
  });

  if (res.status !== 200) {
    throw new Error(
      `验证 Magic Link 失败: HTTP ${res.status} —— ${JSON.stringify(res.data)?.slice(0, 200)}`
    );
  }

  if (res.data?.success !== true) {
    throw new Error(`验证 Magic Link 失败: ${JSON.stringify(res.data)}`);
  }

  logger.info(
    `✅ 验证成功！账号: ${res.data.account?.email_address || 'unknown'}（created: ${res.data.created}）`
  );
  return res.data;
}

/**
 * 解析 Magic Link 的 hash 部分
 * 格式：https://claude.ai/magic-link#<nonce>:<base64邮箱>
 * @param {string} magicLink
 * @returns {{ nonce: string, encodedEmail: string }}
 */
function parseMagicLink(magicLink) {
  const hash = magicLink.split('#')[1];
  if (!hash) {
    throw new Error(`Magic Link 格式无效: ${magicLink}`);
  }
  const [nonce, encodedEmail] = hash.split(':');
  if (!nonce || !encodedEmail) {
    throw new Error(`Magic Link hash 解析失败: ${hash}`);
  }
  return { nonce, encodedEmail };
}

/**
 * 构建 Claude 所需的 Cookie 字符串
 * 优先级：.env 的 CLAUDE_COOKIE（整体覆盖） > 动态探测值（__cf_bm/_cfuvid 等） > 静态配置
 * @returns {string}
 */
function buildClaudeCookie() {
  if (CLAUDE_COOKIE_OVERRIDE) {
    return CLAUDE_COOKIE_OVERRIDE;
  }
  const cookieMap = new Map(CLAUDE_COOKIE_CONFIG.map((c) => [c.name, c.value]));
  // 动态探测到的值覆盖静态配置（会话级凭证每次启动刷新）
  Object.entries(dynamicCookies).forEach(([name, value]) => cookieMap.set(name, value));
  return [...cookieMap].map(([name, value]) => `${name}=${value}`).join('; ');
}

export {
  checkEmailAvailability,
  sendMagicLink,
  exchangeNonceForCode,
  verifyMagicLink,
  parseMagicLink,
  refreshCloudflareCookies,
  BROWSER_HEADERS,
};
