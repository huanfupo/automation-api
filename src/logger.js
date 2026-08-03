/**
 * 日志模块
 * - 请求日志（request）：记录所有 HTTP 请求与响应
 * - 错误日志（error）：记录所有异常与报错信息
 * - 支持按天滚动归档，保留 14 天
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

// ESM 中无 __dirname，通过 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');

// 通用日志格式
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
    if (stack) {
      return `[${timestamp}] [${level.toUpperCase()}] ${message}\nStack: ${stack}${metaStr}`;
    }
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  })
);

// 控制台输出格式（带颜色）
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] ${level}: ${message}`;
  })
);

// 请求日志 transport —— 按天滚动
const requestTransport = new DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'request-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  level: 'info',
  format: logFormat,
});

// 错误日志 transport —— 按天滚动
const errorTransport = new DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  level: 'error',
  format: logFormat,
});

// 创建 logger 实例
const logger = winston.createLogger({
  transports: [
    requestTransport,
    errorTransport,
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

export default logger;
