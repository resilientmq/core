import {LogLevel} from "../types";

type SampledLogLevel = Exclude<LogLevel, 'none'>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    none: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4
};

/**
 * Internal state for current log level.
 */
let currentLevel: LogLevel = 'none';

/**
 * Whether to include timestamps in log messages.
 */
let includeTimestamps = true; 

const SAMPLE_ENV_BY_LEVEL: Record<SampledLogLevel, string> = {
    error: 'RESILIENTMQ_LOG_SAMPLE_ERROR',
    warn: 'RESILIENTMQ_LOG_SAMPLE_WARN',
    info: 'RESILIENTMQ_LOG_SAMPLE_INFO',
    debug: 'RESILIENTMQ_LOG_SAMPLE_DEBUG',
};

const sampleEveryByLevel: Record<SampledLogLevel, number> = {
    error: 1,
    warn: 1,
    info: 1,
    debug: 1,
};

const sampleCountersByLevel: Record<SampledLogLevel, number> = {
    error: 0,
    warn: 0,
    info: 0,
    debug: 0,
};

function normalizeSampleEvery(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 1;
    }
    return Math.max(1, Math.floor(parsed));
}

function configureSamplingFromEnv(): void {
    for (const level of Object.keys(SAMPLE_ENV_BY_LEVEL) as SampledLogLevel[]) {
        const envName = SAMPLE_ENV_BY_LEVEL[level];
        const envValue = typeof process !== 'undefined' ? process.env?.[envName] : undefined;
        if (envValue !== undefined) {
            sampleEveryByLevel[level] = normalizeSampleEvery(envValue);
            sampleCountersByLevel[level] = 0;
        }
    }
}

function applyProductionSamplingDefaults(): void {
    const nodeEnv = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
    if (nodeEnv !== 'production') {
        return;
    }

    // High-throughput defaults; explicit env vars always win.
    if (typeof process !== 'undefined') {
        if (process.env?.RESILIENTMQ_LOG_SAMPLE_INFO === undefined) {
            sampleEveryByLevel.info = 50;
            sampleCountersByLevel.info = 0;
        }
        if (process.env?.RESILIENTMQ_LOG_SAMPLE_DEBUG === undefined) {
            sampleEveryByLevel.debug = 200;
            sampleCountersByLevel.debug = 0;
        }
    }
}

configureSamplingFromEnv();
applyProductionSamplingDefaults();

/**
 * Updates the global log level for the library.
 *
 * @param level - Desired log level to use.
 */
export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

/**
 * Configures whether timestamps should be included in log messages.
 *
 * @param enabled - Whether to include timestamps.
 */
export function setLogTimestamps(enabled: boolean): void {
    includeTimestamps = enabled;
}

/**
 * Configures the sampling ratio for a specific level.
 * Example: everyN=10 logs 1 out of every 10 messages.
 */
export function setLogSampleRate(level: SampledLogLevel, everyN: number): void {
    sampleEveryByLevel[level] = normalizeSampleEvery(everyN);
    sampleCountersByLevel[level] = 0;
}

/**
 * Configures sampling ratios for multiple levels.
 */
export function setLogSampling(config: Partial<Record<SampledLogLevel, number>>): void {
    for (const [level, everyN] of Object.entries(config) as Array<[SampledLogLevel, number]>) {
        setLogSampleRate(level, everyN);
    }
}

/**
 * Returns whether a given log level is currently enabled.
 */
export function isLogLevelEnabled(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel];
}

function shouldEmitBySampling(level: LogLevel): boolean {
    if (level === 'none') {
        return false;
    }

    const everyN = sampleEveryByLevel[level];
    if (everyN <= 1) {
        return true;
    }

    sampleCountersByLevel[level] += 1;
    return ((sampleCountersByLevel[level] - 1) % everyN) === 0;
}

/**
 * Gets a formatted timestamp string.
 */
function getTimestamp(): string {
    return new Date().toISOString();
}

/**
 * Formats a log message with optional timestamp.
 */
function formatMessage(message: string): string {
    if (includeTimestamps) {
        return `[${getTimestamp()}] ${message}`;
    }
    return message;
}

/**
 * Logs a message if the current level allows it.
 *
 * @param level - Level of this specific log.
 * @param message - Message to log.
 * @param optionalParams - Optional additional data to log.
 */
export function log(level: LogLevel, message: string, ...optionalParams: unknown[]): void {
    if (isLogLevelEnabled(level)) {
        if (!shouldEmitBySampling(level)) {
            return;
        }

        const formattedMessage = formatMessage(message);

        if (level === 'error') {
            console.error(formattedMessage, ...optionalParams);
        } else if (level === 'warn') {
            console.warn(formattedMessage, ...optionalParams);
        } else if (level === 'info') {
            console.info(formattedMessage, ...optionalParams);
        } else if (level === 'debug') {
            console.log(formattedMessage, ...optionalParams);
        }
    }
}
