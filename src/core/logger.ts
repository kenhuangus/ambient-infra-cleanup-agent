/**
 * Logger contract + a minimal default implementation.
 *
 * OWNED BY: Wave 1 (Lead-approval required to change).
 * The interface is part of the locked contract surface (re-exported via
 * `src/contracts`). The `createLogger` impl is a shared core utility.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every line it emits. */
  child(fields: LogFields): Logger;
}

export interface CreateLoggerOptions {
  /** Minimum level to emit. Defaults to `'info'`. */
  level?: LogLevel;
  /** Bound fields included on every line. */
  base?: LogFields;
  /** Sink for emitting a formatted line. Defaults to console. */
  sink?: (level: LogLevel, line: string) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function defaultSink(level: LogLevel, line: string): void {
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Default JSON-line logger. Zero dependencies; safe for background runs.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const min = LEVEL_ORDER[options.level ?? 'info'];
  const base = options.base ?? {};
  const sink = options.sink ?? defaultSink;

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < min) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...base,
      ...(fields ?? {}),
    };
    sink(level, JSON.stringify(record));
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) =>
      createLogger({
        level: options.level,
        base: { ...base, ...fields },
        sink,
      }),
  };
}
