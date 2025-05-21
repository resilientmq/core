import {LogLevel} from "../types";

/**
 * Internal state for current log level.
 */
let currentLevel: LogLevel = 'none';

/**
 * Updates the global log level for the library.
 *
 * @param level - Desired log level to use.
 */
export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
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
        info: 3
    };

    if (levels[level] <= levels[currentLevel]) {
        if (level === 'error') {
            console.error(message, ...optionalParams);
        } else if (level === 'warn') {
            console.warn(message, ...optionalParams);
        } else if (level === 'info') {
            console.info(message, ...optionalParams);
        }
    }
}
