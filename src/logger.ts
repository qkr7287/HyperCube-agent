// Minimal tagged logger. LOG_LEVEL env var gates output.
type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

function format(level: LogLevel, tag: string, message: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] [${tag}] ${message}`;
}

export function createLogger(tag: string) {
  return {
    debug(msg: string): void {
      if (shouldLog("debug")) console.debug(format("debug", tag, msg));
    },
    info(msg: string): void {
      if (shouldLog("info")) console.log(format("info", tag, msg));
    },
    warn(msg: string): void {
      if (shouldLog("warn")) console.warn(format("warn", tag, msg));
    },
    error(msg: string): void {
      if (shouldLog("error")) console.error(format("error", tag, msg));
    },
  };
}
