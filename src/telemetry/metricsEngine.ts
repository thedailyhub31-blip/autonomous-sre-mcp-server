import { logger } from '../utils/logger.js';

export type MetricType = 'cpu' | 'memory' | 'error_rate' | 'latency_p99';

export interface MetricDataPoint {
  timestamp: string; // ISO 8601
  value: number;
  unit: string;
  isAnomaly?: boolean;
  anomalyReason?: string;
}

export interface MetricSummary {
  current: number;
  min: number;
  max: number;
  avg: number;
  p95: number;
  p99: number;
  baselineMean: number;
  baselineStdDev: number;
  unit: string;
}

export interface AnomalyAlert {
  timestamp: string;
  metricType: MetricType;
  value: number;
  baselineMean: number;
  threshold: number;
  severity: 'warning' | 'critical';
  spikePercentage: number;
  description: string;
}

export interface MetricQueryResult {
  serviceName: string;
  metricType: MetricType;
  timeframeMinutes: number;
  unit: string;
  summary: MetricSummary;
  anomaliesDetected: AnomalyAlert[];
  dataPoints: MetricDataPoint[];
}

export type IncidentSimulationType =
  | 'db_connection_pool_exhaustion'
  | 'high_5xx_spike'
  | 'memory_leak'
  | 'cpu_throttling';

interface MetricConfig {
  unit: string;
  baselineMin: number;
  baselineMax: number;
  warningThreshold: number;
  criticalThreshold: number;
}

const METRIC_CONFIGS: Record<MetricType, MetricConfig> = {
  cpu: {
    unit: '%',
    baselineMin: 18,
    baselineMax: 32,
    warningThreshold: 75,
    criticalThreshold: 90,
  },
  memory: {
    unit: 'MB',
    baselineMin: 420,
    baselineMax: 540,
    warningThreshold: 850,
    criticalThreshold: 950,
  },
  error_rate: {
    unit: '%',
    baselineMin: 0.01,
    baselineMax: 0.15,
    warningThreshold: 2.0,
    criticalThreshold: 8.0,
  },
  latency_p99: {
    unit: 'ms',
    baselineMin: 35,
    baselineMax: 65,
    warningThreshold: 300,
    criticalThreshold: 1000,
  },
};

export class MetricsEngine {
  // Store metrics: serviceName -> metricType -> Array of DataPoint
  private storage: Map<string, Map<MetricType, MetricDataPoint[]>> = new Map();

  constructor() {
    this.seedDefaultServices();
  }

  private seedDefaultServices(): void {
    const services = ['order-service', 'payment-gateway', 'auth-service', 'inventory-api', 'notification-service'];
    const metricTypes: MetricType[] = ['cpu', 'memory', 'error_rate', 'latency_p99'];
    const now = Date.now();
    const historyMinutes = 60;

    for (const service of services) {
      const serviceMetrics = new Map<MetricType, MetricDataPoint[]>();

      for (const mType of metricTypes) {
        const config = METRIC_CONFIGS[mType];
        const points: MetricDataPoint[] = [];

        for (let i = historyMinutes; i >= 0; i--) {
          const timestamp = new Date(now - i * 60 * 1000).toISOString();
          // Generate small natural jitter
          const baseline =
            config.baselineMin +
            Math.random() * (config.baselineMax - config.baselineMin);
          const rounded = Math.round(baseline * 100) / 100;
          points.push({
            timestamp,
            value: rounded,
            unit: config.unit,
            isAnomaly: false,
          });
        }
        serviceMetrics.set(mType, points);
      }
      this.storage.set(service, serviceMetrics);
    }

    logger.info('MetricsEngine initialized with baseline time-series data', {
      services,
      historyMinutes,
    });
  }

  private ensureServiceMetrics(serviceName: string): Map<MetricType, MetricDataPoint[]> {
    let serviceMetrics = this.storage.get(serviceName);
    if (!serviceMetrics) {
      serviceMetrics = new Map();
      const metricTypes: MetricType[] = ['cpu', 'memory', 'error_rate', 'latency_p99'];
      const now = Date.now();
      for (const mType of metricTypes) {
        const config = METRIC_CONFIGS[mType];
        const points: MetricDataPoint[] = [];
        for (let i = 60; i >= 0; i--) {
          const timestamp = new Date(now - i * 60 * 1000).toISOString();
          const baseline =
            config.baselineMin +
            Math.random() * (config.baselineMax - config.baselineMin);
          points.push({
            timestamp,
            value: Math.round(baseline * 100) / 100,
            unit: config.unit,
            isAnomaly: false,
          });
        }
        serviceMetrics.set(mType, points);
      }
      this.storage.set(serviceName, serviceMetrics);
    }
    return serviceMetrics;
  }

  public recordMetric(
    serviceName: string,
    metricType: MetricType,
    value: number,
    timestampIso?: string
  ): void {
    const serviceMetrics = this.ensureServiceMetrics(serviceName);
    const points = serviceMetrics.get(metricType) || [];
    const config = METRIC_CONFIGS[metricType];
    const timestamp = timestampIso || new Date().toISOString();

    const isAnomaly = value >= config.warningThreshold;
    points.push({
      timestamp,
      value: Math.round(value * 100) / 100,
      unit: config.unit,
      isAnomaly,
      anomalyReason: isAnomaly
        ? `Exceeded ${value >= config.criticalThreshold ? 'critical' : 'warning'} threshold (${config.warningThreshold}${config.unit})`
        : undefined,
    });

    serviceMetrics.set(metricType, points);
  }

  public queryMetrics(
    serviceName: string,
    metricType: MetricType,
    timeframeMinutes: number = 15
  ): MetricQueryResult {
    const serviceMetrics = this.ensureServiceMetrics(serviceName);
    const allPoints = serviceMetrics.get(metricType) || [];
    const config = METRIC_CONFIGS[metricType];

    const cutoffTime = Date.now() - timeframeMinutes * 60 * 1000;
    const windowPoints = allPoints.filter(
      (p) => new Date(p.timestamp).getTime() >= cutoffTime
    );

    const values = windowPoints.map((p) => p.value);
    if (values.length === 0) {
      return {
        serviceName,
        metricType,
        timeframeMinutes,
        unit: config.unit,
        summary: {
          current: 0,
          min: 0,
          max: 0,
          avg: 0,
          p95: 0,
          p99: 0,
          baselineMean: 0,
          baselineStdDev: 0,
          unit: config.unit,
        },
        anomaliesDetected: [],
        dataPoints: [],
      };
    }

    // Statistical calculations
    const sorted = [...values].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const sum = values.reduce((acc, v) => acc + v, 0);
    const avg = Math.round((sum / values.length) * 100) / 100;
    const current = values[values.length - 1];

    const p95Index = Math.min(
      Math.floor(sorted.length * 0.95),
      sorted.length - 1
    );
    const p99Index = Math.min(
      Math.floor(sorted.length * 0.99),
      sorted.length - 1
    );
    const p95 = sorted[p95Index];
    const p99 = sorted[p99Index];

    // Compute standard deviation
    const variance =
      values.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / values.length;
    const stdDev = Math.round(Math.sqrt(variance) * 100) / 100;

    // Detect anomalies using dynamic 3-sigma and static SLA thresholds
    const dynamicThreshold = avg + 2.5 * stdDev;
    const anomalies: AnomalyAlert[] = [];

    const enrichedPoints = windowPoints.map((point) => {
      const isCritical =
        point.value >= config.criticalThreshold ||
        (point.value > dynamicThreshold && point.value > config.warningThreshold);
      const isWarning =
        !isCritical &&
        (point.value >= config.warningThreshold || point.value > dynamicThreshold);

      if (isCritical || isWarning) {
        const severity: 'warning' | 'critical' = isCritical ? 'critical' : 'warning';
        const spikePercentage =
          avg > 0
            ? Math.round(((point.value - avg) / avg) * 100)
            : Math.round(point.value * 100);

        anomalies.push({
          timestamp: point.timestamp,
          metricType,
          value: point.value,
          baselineMean: avg,
          threshold: isCritical ? config.criticalThreshold : config.warningThreshold,
          severity,
          spikePercentage,
          description: `${severity.toUpperCase()}: ${metricType} reached ${point.value}${config.unit} (+${spikePercentage}% deviation from baseline mean ${avg}${config.unit})`,
        });

        return {
          ...point,
          isAnomaly: true,
          anomalyReason: `${severity.toUpperCase()} spike: ${point.value}${config.unit} vs baseline ${avg}${config.unit}`,
        };
      }

      return {
        ...point,
        isAnomaly: false,
      };
    });

    return {
      serviceName,
      metricType,
      timeframeMinutes,
      unit: config.unit,
      summary: {
        current,
        min,
        max,
        avg,
        p95,
        p99,
        baselineMean: (config.baselineMin + config.baselineMax) / 2,
        baselineStdDev: stdDev,
        unit: config.unit,
      },
      anomaliesDetected: anomalies,
      dataPoints: enrichedPoints,
    };
  }

  public injectMetricSpike(
    serviceName: string,
    incidentType: IncidentSimulationType,
    severity: 'warning' | 'critical' = 'critical',
    minutesDuration: number = 8
  ): void {
    logger.warn('Injecting simulated metric spike', {
      serviceName,
      incidentType,
      severity,
      minutesDuration,
    });

    const now = Date.now();

    for (let i = minutesDuration; i >= 0; i--) {
      const timestamp = new Date(now - i * 60 * 1000).toISOString();

      switch (incidentType) {
        case 'db_connection_pool_exhaustion': {
          // Latency jumps from 50ms to 6500ms - 9200ms
          const latencyMultiplier = severity === 'critical' ? 7500 : 3500;
          const latency = latencyMultiplier + Math.random() * 1500;
          this.recordMetric(serviceName, 'latency_p99', latency, timestamp);

          // Error rate jumps to 40% - 65% (HTTP 500 / 503)
          const errorRate = severity === 'critical' ? 42 + Math.random() * 22 : 18 + Math.random() * 10;
          this.recordMetric(serviceName, 'error_rate', errorRate, timestamp);

          // CPU spikes due to connection pool retries and thread spinlock
          const cpu = severity === 'critical' ? 88 + Math.random() * 10 : 72 + Math.random() * 8;
          this.recordMetric(serviceName, 'cpu', cpu, timestamp);
          break;
        }

        case 'high_5xx_spike': {
          // 5xx error rate spikes drastically
          const errorRate = severity === 'critical' ? 52 + Math.random() * 25 : 22 + Math.random() * 12;
          this.recordMetric(serviceName, 'error_rate', errorRate, timestamp);

          // Latency degrades
          const latency = severity === 'critical' ? 2400 + Math.random() * 900 : 1200 + Math.random() * 400;
          this.recordMetric(serviceName, 'latency_p99', latency, timestamp);
          break;
        }

        case 'memory_leak': {
          // Memory climbs steeply
          const baseMemory = 600;
          const leakProgress = (minutesDuration - i + 1) * 45;
          const memory = baseMemory + leakProgress;
          this.recordMetric(serviceName, 'memory', memory, timestamp);

          // GC pauses cause latency spikes
          if (i <= 3) {
            this.recordMetric(serviceName, 'latency_p99', 1800 + Math.random() * 800, timestamp);
            this.recordMetric(serviceName, 'error_rate', 15 + Math.random() * 10, timestamp);
          }
          break;
        }

        case 'cpu_throttling': {
          const cpu = severity === 'critical' ? 96 + Math.random() * 3.5 : 82 + Math.random() * 6;
          this.recordMetric(serviceName, 'cpu', cpu, timestamp);
          const latency = 2800 + Math.random() * 1200;
          this.recordMetric(serviceName, 'latency_p99', latency, timestamp);
          break;
        }
      }
    }
  }
}

export const metricsEngine = new MetricsEngine();
