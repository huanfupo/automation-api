/**
 * 项目入口
 * 启动爬虫自动化流程
 */

import 'dotenv/config';
import logger from './logger.js';
import { run } from './crawler.js';

async function main() {
  logger.info('');
  logger.info('╔══════════════════════════════════════╗');
  logger.info('║   Node.js 爬虫 —— Claude 自动注册   ║');
  logger.info('╚══════════════════════════════════════╝');
  logger.info('');

  const startTime = Date.now();

  const result = await run();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  logger.info('');
  logger.info(`⏱️  总耗时: ${elapsed}s`);
  logger.info(`📊 最终结果: ${result.success ? '✅ 成功' : '❌ 失败'}`);

  if (!result.success) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error(`💥 未捕获的异常: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
