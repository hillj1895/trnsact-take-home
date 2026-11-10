/**
 * Minimal structured (JSON-lines) logger. One line per event so CloudWatch Logs
 * Insights / any log pipeline can query fields directly.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  base: Record<string, unknown> = {},
  level: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    // stderr keeps stdout free for data output.
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields }) + '\n',
    );
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger({ ...base, ...f }, level),
  };
}
