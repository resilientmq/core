/**
 * Represents the logging level used throughout the library.
 *
 * - `'none'` – Disable all logging.
 * - `'error'` – Only errors are logged.
 * - `'warn'` – Only warnings and errors are logged.
 * - `'info'` – Informational, warning, and error messages are logged.
 * - `'debug'` – All messages including detailed debug information are logged.
 */
export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';
