import { log, setLogLevel, setLogSampleRate, setLogSampling, setLogTimestamps } from '../../../src/logger/logger';

describe('Logger', () => {
    let consoleErrorSpy: jest.SpyInstance;
    let consoleWarnSpy: jest.SpyInstance;
    let consoleInfoSpy: jest.SpyInstance;
    let consoleLogSpy: jest.SpyInstance;

    beforeEach(() => {
        // Spy on console methods
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
        consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation();
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

        // Reset to default state
        setLogLevel('info');
        setLogTimestamps(true);
        setLogSampling({ error: 1, warn: 1, info: 1, debug: 1 });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('setLogLevel', () => {
        it('should set log level to none', () => {
            setLogLevel('none');
            
            log('error', 'Error message');
            log('warn', 'Warning message');
            log('info', 'Info message');
            log('debug', 'Debug message');

            expect(consoleErrorSpy).not.toHaveBeenCalled();
            expect(consoleWarnSpy).not.toHaveBeenCalled();
            expect(consoleInfoSpy).not.toHaveBeenCalled();
            expect(consoleLogSpy).not.toHaveBeenCalled();
        });

        it('should set log level to error', () => {
            setLogLevel('error');
            
            log('error', 'Error message');
            log('warn', 'Warning message');
            log('info', 'Info message');
            log('debug', 'Debug message');

            expect(consoleErrorSpy).toHaveBeenCalled();
            expect(consoleWarnSpy).not.toHaveBeenCalled();
            expect(consoleInfoSpy).not.toHaveBeenCalled();
            expect(consoleLogSpy).not.toHaveBeenCalled();
        });

        it('should set log level to warn', () => {
            setLogLevel('warn');
            
            log('error', 'Error message');
            log('warn', 'Warning message');
            log('info', 'Info message');
            log('debug', 'Debug message');

            expect(consoleErrorSpy).toHaveBeenCalled();
            expect(consoleWarnSpy).toHaveBeenCalled();
            expect(consoleInfoSpy).not.toHaveBeenCalled();
            expect(consoleLogSpy).not.toHaveBeenCalled();
        });

        it('should set log level to info', () => {
            setLogLevel('info');
            
            log('error', 'Error message');
            log('warn', 'Warning message');
            log('info', 'Info message');
            log('debug', 'Debug message');

            expect(consoleErrorSpy).toHaveBeenCalled();
            expect(consoleWarnSpy).toHaveBeenCalled();
            expect(consoleInfoSpy).toHaveBeenCalled();
            expect(consoleLogSpy).not.toHaveBeenCalled();
        });

        it('should set log level to debug', () => {
            setLogLevel('debug');
            
            log('error', 'Error message');
            log('warn', 'Warning message');
            log('info', 'Info message');
            log('debug', 'Debug message');

            expect(consoleErrorSpy).toHaveBeenCalled();
            expect(consoleWarnSpy).toHaveBeenCalled();
            expect(consoleInfoSpy).toHaveBeenCalled();
            expect(consoleLogSpy).toHaveBeenCalled();
        });
    });

    describe('log', () => {
        beforeEach(() => {
            setLogLevel('debug');
        });

        it('should log error messages to console.error', () => {
            log('error', 'Test error message');

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Test error message'),
            );
        });

        it('should log warn messages to console.warn', () => {
            log('warn', 'Test warning message');

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Test warning message'),
            );
        });

        it('should log info messages to console.info', () => {
            log('info', 'Test info message');

            expect(consoleInfoSpy).toHaveBeenCalledWith(
                expect.stringContaining('Test info message'),
            );
        });

        it('should log debug messages to console.log', () => {
            log('debug', 'Test debug message');

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('Test debug message'),
            );
        });

        it('should include optional parameters', () => {
            const errorObj = new Error('Test error');
            const metadata = { userId: '123', action: 'create' };

            log('error', 'Error occurred', errorObj, metadata);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Error occurred'),
                errorObj,
                metadata
            );
        });

        it('should handle multiple optional parameters', () => {
            log('info', 'Multiple params', 'param1', 'param2', 'param3');

            expect(consoleInfoSpy).toHaveBeenCalledWith(
                expect.stringContaining('Multiple params'),
                'param1',
                'param2',
                'param3'
            );
        });
    });

    describe('setLogTimestamps', () => {
        beforeEach(() => {
            setLogLevel('info');
        });

        it('should include timestamps when enabled', () => {
            setLogTimestamps(true);

            log('info', 'Test message');

            expect(consoleInfoSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] Test message/)
            );
        });

        it('should not include timestamps when disabled', () => {
            setLogTimestamps(false);

            log('info', 'Test message');

            expect(consoleInfoSpy).toHaveBeenCalledWith('Test message');
        });

        it('should format timestamp in ISO format', () => {
            setLogTimestamps(true);

            log('info', 'Test message');

            const call = consoleInfoSpy.mock.calls[0][0];
            expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
        });
    });

    describe('message formatting', () => {
        beforeEach(() => {
            setLogLevel('debug');
        });

        it('should format message with timestamp prefix', () => {
            setLogTimestamps(true);

            log('info', 'Formatted message');

            const call = consoleInfoSpy.mock.calls[0][0];
            expect(call).toContain('[');
            expect(call).toContain(']');
            expect(call).toContain('Formatted message');
        });

        it('should format message without timestamp when disabled', () => {
            setLogTimestamps(false);

            log('info', 'Plain message');

            expect(consoleInfoSpy).toHaveBeenCalledWith('Plain message');
        });

        it('should preserve message content exactly', () => {
            setLogTimestamps(false);

            const message = 'Special chars: !@#$%^&*()';
            log('info', message);

            expect(consoleInfoSpy).toHaveBeenCalledWith(message);
        });
    });

    describe('sampling', () => {
        beforeEach(() => {
            setLogLevel('debug');
            setLogTimestamps(false);
            setLogSampling({ error: 1, warn: 1, info: 1, debug: 1 });
        });

        it('should log all messages when sampling is 1', () => {
            setLogSampleRate('info', 1);

            log('info', 'm1');
            log('info', 'm2');
            log('info', 'm3');

            expect(consoleInfoSpy).toHaveBeenCalledTimes(3);
        });

        it('should sample info logs when sampling is greater than 1', () => {
            setLogSampleRate('info', 3);

            for (let i = 0; i < 10; i++) {
                log('info', `msg-${i}`);
            }

            expect(consoleInfoSpy).toHaveBeenCalledTimes(4);
        });

        it('should reset sampling counter when sample rate changes', () => {
            setLogSampleRate('info', 3);
            log('info', 'a');
            log('info', 'b');

            setLogSampleRate('info', 2);
            log('info', 'c');

            expect(consoleInfoSpy).toHaveBeenCalledTimes(2);
        });

        it('should normalize invalid sample rates to 1', () => {
            setLogSampleRate('debug', 0 as any);
            log('debug', 'd1');
            log('debug', 'd2');

            expect(consoleLogSpy).toHaveBeenCalledTimes(2);
        });
    });
});
