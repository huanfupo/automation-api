/**
 * 邮件服务模块
 * - 生成临时邮箱地址
 * - 获取邮箱收件列表（提取 magic link）
 */

import { request, sleep } from '../utils/request.js';
import logger from '../logger.js';

// 配置常量
const MAIL_BASE_URL = 'https://mail.chaip.app/web/api';
const MAIL_COOKIE = 'chaip_session=frWOzH6FTYgEY7c-VMo3bMK8DyHoYkFnw0HJ5L2Y5RM';
const POLL_INTERVAL = 5000; // 轮询间隔 5 秒
const MAX_POLL_RETRIES = 24; // 最多轮询 24 次（2 分钟）

/**
 *  邮箱 浏览器 headers（模拟正常浏览器访问）
 */
const BROWSER_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Content-Type': 'application/json',
  Origin: 'https://mail.chaip.app',
  Referer: 'https://mail.chaip.app',
  'Sec-Ch-Ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Version': '"151.0.0.0"',
  'X-Chaip-Request': 'web',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
};

/**
 * 生成临时邮箱地址（可批量）
 * 真实接口：POST /web/api/v1/mailboxes，body { count }
 * @param {number} count - 生成数量，默认 1
 * @returns {Promise<object>} { address, password, createdAt }
 */
async function generateEmail(count = 1) {
  logger.info(`📧 正在生成 ${count} 个临时邮箱...`);

  const res = await request({
    method: 'POST',
    url: `${MAIL_BASE_URL}/v1/mailboxes`,
    headers: {
      ...BROWSER_HEADERS,
      Cookie: MAIL_COOKIE,
    },
    data: {
      count,
    },
  });

  if (res.status !== 201) {
    throw new Error(
      `生成邮箱失败: HTTP ${res.status} —— ${JSON.stringify(res.data) || '无响应体'}`
    );
  }

  const items = res.data?.data?.items || [];
  if (items.length === 0) {
    throw new Error('生成邮箱失败: 响应中没有邮箱数据');
  }

  const mailbox = items[0];
  logger.info(`✅ 邮箱生成成功: ${mailbox.address}`);
  return mailbox;
}

/**
 * 轮询获取邮箱收件列表，查找 Claude 的 magic link 邮件
 * @param {string} address - 邮箱地址
 * @returns {Promise<object|null>} 包含 magic link 的邮件对象
 */
async function waitForMagicLink(address) {
  logger.info(`📬 开始监听邮箱 ${address}，等待 Claude 验证邮件...`);

  for (let i = 1; i <= MAX_POLL_RETRIES; i++) {
    logger.info(`🔍 第 ${i}/${MAX_POLL_RETRIES} 次查询邮件列表...`);

    const res = await request({
      method: 'GET',
      url: `${MAIL_BASE_URL}/messages`,
      headers: {
        Cookie: MAIL_COOKIE,
      },
      params: {
        limit: 50,
        address,
      },
    });

    if (res.status !== 200) {
      logger.error(`查询邮件失败: HTTP ${res.status}`);
      await sleep(POLL_INTERVAL);
      continue;
    }

    // 真实响应结构：{ data: { items: [...] }, error: null }
    const messages = res.data?.data?.items || [];

    if (Array.isArray(messages) && messages.length > 0) {
      // 查找包含 magic-link 的邮件
      const magicEmail = messages.find(
        (msg) =>
          msg.bodyText &&
          (msg.bodyText.includes('magic-link') || msg.bodyText.includes('Sign in to Claude'))
      );

      if (magicEmail) {
        logger.info(`🎯 找到 Claude 验证邮件: ${magicEmail.subject}`);

        // 提取 magic link URL
        const magicLink = extractMagicLink(magicEmail.bodyText);
        if (magicLink) {
          logger.info(`🔗 提取到 Magic Link: ${magicLink.slice(0, 60)}...`);
        }

        return {
          id: magicEmail.id,
          subject: magicEmail.subject,
          sender: magicEmail.sender,
          bodyText: magicEmail.bodyText,
          magicLink,
        };
      }

      logger.info(`📨 查到 ${messages.length} 封邮件，暂无 Claude 验证邮件`);
    } else {
      logger.info('📭 暂无新邮件');
    }

    if (i < MAX_POLL_RETRIES) {
      await sleep(POLL_INTERVAL);
    }
  }

  logger.warn('⏰ 超时：未在指定时间内收到 Claude 验证邮件');
  return null;
}

/**
 * 从邮件正文中提取 magic link URL
 * @param {string} bodyText
 * @returns {string|null}
 */
function extractMagicLink(bodyText) {
  // 匹配 https://claude.ai/magic-link#... 格式的链接
  const match = bodyText.match(/https:\/\/claude\.ai\/magic-link[^\s)]+/);
  return match ? match[0] : null;
}

export { generateEmail, waitForMagicLink, extractMagicLink };
