import winston from 'winston';
import { envConfig } from '@/config';
import { sanitizeForLogging } from './errorSanitizer';

/**
 * Custom formatter that sanitizes log data to prevent "Invalid string length" errors
 */
const sanitizeFormat = winston.format((info) => {
  // Sanitize any error objects or large data in the info object
  if (info.error) {
    info.error = sanitizeForLogging(info.error);
  }
  
  // Sanitize splat arguments (additional data passed to logger)
  // Winston uses splat for additional arguments: logger.error('msg', arg1, arg2)
  const splatSymbol = Symbol.for('splat');
  if (info[splatSymbol] && Array.isArray(info[splatSymbol])) {
    info[splatSymbol] = (info[splatSymbol] as unknown[]).map((arg: unknown) =>
      sanitizeForLogging(arg)
    );
  }
  
  // Sanitize all other properties that might contain large data
  // Note: We iterate over keys to avoid mutating while iterating
  const keysToSanitize: string[] = [];
  for (const key of Object.keys(info)) {
    // Skip Winston internal symbols and already processed fields
    if (typeof key === 'symbol') {
      continue;
    }
    
    // Skip timestamp, level, message, service as they're safe
    if (['timestamp', 'level', 'message', 'service', 'error'].includes(key)) {
      continue;
    }
    
    // Mark for sanitization
    keysToSanitize.push(key);
  }
  
  // Sanitize marked keys
  for (const key of keysToSanitize) {
    info[key] = sanitizeForLogging(info[key]);
  }
  
  return info;
})();

/**
 * Winston logger configuration with file rotation
 *
 * Features:
 * - Logs are written to separate files for errors and general logs
 * - Maximum file size: 5MB
 * - Keeps up to 5 most recent rotated log files
 * - When a file reaches 5MB, it's renamed and a new file is created
 * - Old log files are automatically deleted when maxFiles limit is reached
 * - Sanitizes large data to prevent "Invalid string length" errors
 *
 * File rotation behavior:
 * - app.log (current log file)
 * - app.log.1 (previous log file)
 * - app.log.2, app.log.3, etc. (older log files)
 */
const logger = winston.createLogger({
  level: envConfig.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    }),
    winston.format.errors({ stack: true }),
    sanitizeFormat,
    winston.format.json()
  ),
  defaultMeta: { service: 'tiktok-video-uploader' },
  transports: [
    // Write all logs with importance level of `error` or less to `error.log`
    // Max file size: 5MB, keep 5 most recent files
    new winston.transports.File({
      filename: envConfig.LOG_FILE_PATH.replace('.log', '-error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB in bytes
      maxFiles: 5,
      tailable: true,
    }),
    // Write all logs with importance level of `info` or less to the main log file
    // Max file size: 5MB, keep 5 most recent files
    new winston.transports.File({
      filename: envConfig.LOG_FILE_PATH,
      maxsize: 5242880, // 5MB in bytes
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

// If we're not in production, log to the console as well
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    })
  );
}

export { logger };
