import * as fs from 'fs';
import * as path from 'path';

/**
 * Performance metrics collected during tests.
 */
export interface Metrics {
    /** Messages processed per second */
    throughput: number;
    
    /** Average latency in milliseconds */
    latencyAvg: number;
    
    /** 50th percentile latency in milliseconds */
    latencyP50: number;
    
    /** 95th percentile latency in milliseconds */
    latencyP95: number;
    
    /** 99th percentile latency in milliseconds */
    latencyP99: number;
    
    /** Memory usage in megabytes */
    memoryUsageMB: number;
    
    /** CPU usage percentage (0-100) */
    cpuUsagePercent: number;
    
    /** Error rate as percentage (0-100) */
    errorRate: number;
    
    /** Total number of messages processed */
    totalMessages: number;
    
    /** Total number of errors encountered */
    totalErrors: number;
    
    /** Duration of the test in milliseconds */
    duration: number;
}

/**
 * Collects performance metrics during stress tests and benchmarks.
 * Tracks latencies, throughput, memory usage, CPU usage, and error rates.
 */
export class MetricsCollector {
    private startTime: number = 0;
    private endTime: number = 0;
    private latencies: number[] = [];
    private errorCount: number = 0;
    private initialMemory: number = 0;
    private cpuUsageStart: NodeJS.CpuUsage | null = null;

    /**
     * Starts collecting metrics.
     * Records initial timestamp, memory usage, and CPU usage.
     */
    start(): void {
        this.startTime = Date.now();
        this.latencies = [];
        this.errorCount = 0;
        this.initialMemory = this.getMemoryUsageMB();
        this.cpuUsageStart = process.cpuUsage();
    }

    /**
     * Records a successful message processing with its latency.
     * @param latency Latency in milliseconds
     */
    recordMessage(latency: number): void {
        this.latencies.push(latency);
    }

    /**
     * Records an error occurrence.
     */
    recordError(): void {
        this.errorCount++;
    }

    /**
     * Stops collecting metrics and calculates final statistics.
     * @returns Calculated metrics
     */
    stop(): Metrics {
        this.endTime = Date.now();
        const duration = this.endTime - this.startTime;
        const totalMessages = this.latencies.length;
        const totalErrors = this.errorCount;

        // Calculate throughput (messages per second)
        const throughput = totalMessages > 0 ? (totalMessages / duration) * 1000 : 0;

        // Calculate latencies
        const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
        const latencyAvg = totalMessages > 0 
            ? this.latencies.reduce((sum, lat) => sum + lat, 0) / totalMessages 
            : 0;
        const latencyP50 = this.calculatePercentile(sortedLatencies, 50);
        const latencyP95 = this.calculatePercentile(sortedLatencies, 95);
        const latencyP99 = this.calculatePercentile(sortedLatencies, 99);

        // Calculate memory usage
        const memoryUsageMB = this.getMemoryUsageMB() - this.initialMemory;

        // Calculate CPU usage
        const cpuUsagePercent = this.calculateCpuUsage();

        // Calculate error rate
        const totalOperations = totalMessages + totalErrors;
        const errorRate = totalOperations > 0 ? (totalErrors / totalOperations) * 100 : 0;

        return {
            throughput,
            latencyAvg,
            latencyP50,
            latencyP95,
            latencyP99,
            memoryUsageMB,
            cpuUsagePercent,
            errorRate,
            totalMessages,
            totalErrors,
            duration
        };
    }

    /**
     * Exports metrics to a JSON file.
     * Creates the directory if it doesn't exist.
     * @param filepath Path to the output JSON file
     */
    exportToJSON(filepath: string): void {
        const metrics = this.endTime > 0 ? this.getLastMetrics() : this.stop();
        
        // Ensure directory exists
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write metrics to file
        fs.writeFileSync(filepath, JSON.stringify(metrics, null, 2), 'utf-8');
    }

    /**
     * Gets the last calculated metrics without recalculating.
     * @returns Last calculated metrics
     */
    private getLastMetrics(): Metrics {
        const duration = this.endTime - this.startTime;
        const totalMessages = this.latencies.length;
        const totalErrors = this.errorCount;

        const throughput = totalMessages > 0 ? (totalMessages / duration) * 1000 : 0;
        const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
        const latencyAvg = totalMessages > 0 
            ? this.latencies.reduce((sum, lat) => sum + lat, 0) / totalMessages 
            : 0;
        const latencyP50 = this.calculatePercentile(sortedLatencies, 50);
        const latencyP95 = this.calculatePercentile(sortedLatencies, 95);
        const latencyP99 = this.calculatePercentile(sortedLatencies, 99);
        const memoryUsageMB = this.getMemoryUsageMB() - this.initialMemory;
        const cpuUsagePercent = this.calculateCpuUsage();
        const totalOperations = totalMessages + totalErrors;
        const errorRate = totalOperations > 0 ? (totalErrors / totalOperations) * 100 : 0;

        return {
            throughput,
            latencyAvg,
            latencyP50,
            latencyP95,
            latencyP99,
            memoryUsageMB,
            cpuUsagePercent,
            errorRate,
            totalMessages,
            totalErrors,
            duration
        };
    }

    /**
     * Calculates a percentile value from sorted latencies.
     * @param sortedLatencies Array of latencies sorted in ascending order
     * @param percentile Percentile to calculate (0-100)
     * @returns Percentile value
     */
    private calculatePercentile(sortedLatencies: number[], percentile: number): number {
        if (sortedLatencies.length === 0) {
            return 0;
        }

        const index = Math.ceil((percentile / 100) * sortedLatencies.length) - 1;
        return sortedLatencies[Math.max(0, index)];
    }

    /**
     * Gets current memory usage in megabytes.
     * @returns Memory usage in MB
     */
    private getMemoryUsageMB(): number {
        const usage = process.memoryUsage();
        return usage.heapUsed / 1024 / 1024;
    }

    /**
     * Calculates CPU usage percentage since start.
     * @returns CPU usage percentage (0-100)
     */
    private calculateCpuUsage(): number {
        if (!this.cpuUsageStart) {
            return 0;
        }

        const cpuUsageEnd = process.cpuUsage(this.cpuUsageStart);
        const totalCpuTime = cpuUsageEnd.user + cpuUsageEnd.system;
        const elapsedTime = (this.endTime - this.startTime) * 1000; // Convert to microseconds

        if (elapsedTime === 0) {
            return 0;
        }

        // CPU usage as percentage (can exceed 100% on multi-core systems)
        return (totalCpuTime / elapsedTime) * 100;
    }

    /**
     * Resets all collected metrics.
     */
    reset(): void {
        this.startTime = 0;
        this.endTime = 0;
        this.latencies = [];
        this.errorCount = 0;
        this.initialMemory = 0;
        this.cpuUsageStart = null;
    }

    /**
     * Gets current snapshot of metrics without stopping collection.
     * Useful for monitoring during long-running tests.
     * @returns Current metrics snapshot
     */
    snapshot(): Metrics {
        const currentTime = Date.now();
        const duration = currentTime - this.startTime;
        const totalMessages = this.latencies.length;
        const totalErrors = this.errorCount;

        const throughput = totalMessages > 0 ? (totalMessages / duration) * 1000 : 0;
        const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
        const latencyAvg = totalMessages > 0 
            ? this.latencies.reduce((sum, lat) => sum + lat, 0) / totalMessages 
            : 0;
        const latencyP50 = this.calculatePercentile(sortedLatencies, 50);
        const latencyP95 = this.calculatePercentile(sortedLatencies, 95);
        const latencyP99 = this.calculatePercentile(sortedLatencies, 99);
        const memoryUsageMB = this.getMemoryUsageMB() - this.initialMemory;
        
        const cpuUsageEnd = this.cpuUsageStart ? process.cpuUsage(this.cpuUsageStart) : { user: 0, system: 0 };
        const totalCpuTime = cpuUsageEnd.user + cpuUsageEnd.system;
        const elapsedTime = duration * 1000;
        const cpuUsagePercent = elapsedTime > 0 ? (totalCpuTime / elapsedTime) * 100 : 0;

        const totalOperations = totalMessages + totalErrors;
        const errorRate = totalOperations > 0 ? (totalErrors / totalOperations) * 100 : 0;

        return {
            throughput,
            latencyAvg,
            latencyP50,
            latencyP95,
            latencyP99,
            memoryUsageMB,
            cpuUsagePercent,
            errorRate,
            totalMessages,
            totalErrors,
            duration
        };
    }
}
