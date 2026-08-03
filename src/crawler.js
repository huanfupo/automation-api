/**
 * 爬虫主编排模块
 * 流程：
 *   1. 生成临时邮箱
 *   2. 用该邮箱在 Claude.ai 注册（发送 magic link）
 *   3. 轮询邮箱，获取 magic link
 *   4. 验证 Magic Link，创建账号（需验证码 token）
 */

import logger from './logger.js';
import { generateEmail, waitForMagicLink } from './services/mailService.js';
import {
  checkEmailAvailability,
  sendMagicLink,
  verifyMagicLink,
  refreshCloudflareCookies,
} from './services/claudeService.js';
import { solveVerificationTokens } from './services/captchaProvider.js';

/**
 * 执行完整的注册流程
 * @returns {Promise<object>} 包含邮箱地址和 magic link 的结果
 */
async function run() {
  const result = {
    email: null,
    magicLink: null,
    account: null,
    success: false,
  };

  try {
    // ===================== 前置：自动获取 Cloudflare 凭证 =====================
    await refreshCloudflareCookies();

    // ===================== 第一步：生成邮箱 =====================
    logger.info('═══════════════════════════════════════');
    logger.info('  🚀 步骤 1/4：生成临时邮箱');
    logger.info('═══════════════════════════════════════');

    const emailData = await generateEmail();
    result.email = emailData.address;
    logger.info(`📋 邮箱信息: ${JSON.stringify(emailData, null, 2)}`);

    // ===================== 第二步：Claude 注册 =====================
    logger.info('');
    logger.info('═══════════════════════════════════════');
    logger.info('  🚀 步骤 2/4：在 Claude.ai 注册');
    logger.info('═══════════════════════════════════════');

    // 2.1 检查邮箱是否可用
    await checkEmailAvailability(result.email);

    // 2.2 发送 magic link
    await sendMagicLink(result.email);

    logger.info('⏳ Magic Link 已发送，等待邮件到达...');

    // ===================== 第三步：获取 Magic Link =====================
    logger.info('');
    logger.info('═══════════════════════════════════════');
    logger.info('  🚀 步骤 3/4：轮询获取 Magic Link');
    logger.info('═══════════════════════════════════════');

    const magicEmail = await waitForMagicLink(result.email);

    if (magicEmail && magicEmail.magicLink) {
      result.magicLink = magicEmail.magicLink;
      result.success = true;

      logger.info('');
      logger.info('═══════════════════════════════════════');
      logger.info('  🎉 Magic Link 获取成功！');
      logger.info('═══════════════════════════════════════');
      logger.info(`  邮箱地址:   ${result.email}`);
      logger.info(`  Magic Link: ${result.magicLink}`);
      logger.info('═══════════════════════════════════════');

      // ===================== 第四步：验证 Magic Link =====================
      logger.info('');
      logger.info('═══════════════════════════════════════');
      logger.info('  🚀 步骤 4/4：验证 Magic Link 创建账号');
      logger.info('═══════════════════════════════════════');

      const arkoseSessionToken = process.env.ARKOSE_SESSION_TOKEN;
      const hcaptchaToken = process.env.HCAPTCHA_TOKEN;

      let captchaTokens = null;

      if (!arkoseSessionToken || !hcaptchaToken) {
        // 未配置 token：优先尝试打码服务自动获取（需 CAPTCHA_PROVIDER_KEY）
        if (process.env.CAPTCHA_PROVIDER_KEY) {
          logger.info('🧩 未配置验证码 token，尝试打码服务自动获取...');
          try {
            captchaTokens = await solveVerificationTokens('https://claude.ai/onboarding');
          } catch (err) {
            logger.warn(`⚠️ 打码服务获取失败: ${err.message}`);
          }
        }

        if (!captchaTokens) {
          // 打码服务未配置或失败：提示手动抓包（token 不可伪造，需真实浏览器）
          logger.warn('⚠️ 未获取到验证码 token，跳过账号创建');
          logger.warn('  手动抓包步骤：');
          logger.warn(
            '  1. 在浏览器（建议日常 Chrome）打开下面的 Magic Link，页面会自动完成验证；'
          );
          logger.warn('  2. F12 → Network 面板，筛选 verify_magic_link 请求；');
          logger.warn(
            '  3. 复制请求体中的 arkose_session_token 和 client_attestation.hcaptcha_token；'
          );
          logger.warn('  4. 填入项目根目录 .env（参考 .env.example），下次运行自动执行第四步。');
          logger.warn(`  Magic Link: ${result.magicLink}`);
        }
      } else {
        captchaTokens = { arkoseSessionToken, hcaptchaToken };
      }

      if (captchaTokens) {
        const verifyResult = await verifyMagicLink(result.magicLink, captchaTokens);
        result.account = verifyResult.account;
        result.accountCreated = verifyResult.created;
        result.success = true;

        logger.info('');
        logger.info('═══════════════════════════════════════');
        logger.info('  🎉 账号创建成功！');
        logger.info('═══════════════════════════════════════');
        logger.info(`  账号 UUID:   ${result.account?.uuid}`);
        logger.info(`  账号邮箱:    ${result.account?.email_address}`);
        logger.info(`  所属组织:    ${result.account?.memberships?.[0]?.organization?.name}`);
        logger.info('═══════════════════════════════════════');
      }
    } else {
      logger.warn('⚠️ 未获取到 Magic Link，流程未完全成功');
    }
  } catch (err) {
    logger.error(`❌ 流程执行失败: ${err.message}`, {
      stack: err.stack,
    });
    result.error = err.message;
  }

  return result;
}

export { run };
