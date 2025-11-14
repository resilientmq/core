import {LogLevel} from "../types";

/**
 * Internal state for current log level.
 */
let currentLevel: LogLevel = 'none';

/**
 * Whether to include timestamps in log messages.
 */
let includeTimestamps = true;

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
    const levels: Record<LogLevel, number> = {
        none: 0,
        error: 1,
        warn: 2,
        info: 3,
        debug: 4
    };

    if (levels[level] <= levels[currentLevel]) {
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
