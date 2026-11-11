import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { IncidentSimulationType } from './metricsEngine.js';

export interface SpanEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  serviceName: string;
  operationName: string;
  endpoint: string;
  httpMethod: string;
  statusCode: number;
  durationMs: number;
  timestamp: string; // ISO 8601
  errorMessage?: string;
  stackTrace?: string;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export interface TraceQuerySummary {
  totalMatchingSpans: number;
  impactedEndpoints: Record<string, number>;
  statusCodeDistribution: Record<number, number>;
  commonExceptions: Array<{
    type: string;
    count: number;
    sampleMessage: string;
  }>;
}

export interface TraceQueryResult {
  serviceName: string;
  minStatusCode: number;
  timeframeMinutes: number;
  summary: TraceQuerySummary;
  spans: TraceSpan[];
}

function generateHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export class TraceParser {
  private spans: TraceSpan[] = [];

  constructor() {
    this.seedBaselineTraces();
  }

  private seedBaselineTraces(): void {
    const services = ['order-service', 'payment-gateway', 'auth-service', 'inventory-api'];
    const now = Date.now();

    for (const service of services) {
      for (let i = 0; i < 20; i++) {
        const timestamp = new Date(now - (i * 2 + 5) * 60 * 1000).toISOString();
        const traceId = generateHex(16);
        const spanId = generateHex(8);
        const duration = Math.floor(25 + Math.random() * 45);

        this.spans.push({
          traceId,
          spanId,
          serviceName: service,
          operationName: 'HTTP GET /api/v1/health',
          endpoint: '/api/v1/health',
          httpMethod: 'GET',
          statusCode: 200,
          durationMs: duration,
          timestamp,
          attributes: {
            'http.method': 'GET',
            'http.status_code': 200,
            'http.route': '/api/v1/health',
            'http.target': '/api/v1/health',
            'net.peer.name': 'ingress-controller.internal',
          },
          events: [
            {
              name: 'request_started',
              timestamp,
            },
            {
              name: 'request_completed',
              timestamp: new Date(new Date(timestamp).getTime() + duration).toISOString(),
            },
          ],
        });
      }
    }

    logger.info('TraceParser initialized with baseline telemetry spans', {
      totalSpans: this.spans.length,
    });
  }

  public recordSpan(span: TraceSpan): void {
    this.spans.push(span);
    // Keep max 2000 spans in memory ring-buffer
    if (this.spans.length > 2000) {
      this.spans.splice(0, this.spans.length - 2000);
    }
  }

  public fetchErrorTraces(
    serviceName: string,
    minStatusCode: number = 500,
    timeframeMinutes: number = 30,
    limit: number = 10
  ): TraceQueryResult {
    const cutoffTime = Date.now() - timeframeMinutes * 60 * 1000;

    const filtered = this.spans.filter((span) => {
      const matchService =
        span.serviceName.toLowerCase() === serviceName.toLowerCase();
      const matchCode = span.statusCode >= minStatusCode;
      const matchTime = new Date(span.timestamp).getTime() >= cutoffTime;
      return matchService && matchCode && matchTime;
    });

    // Sort descending by timestamp (newest errors first)
    filtered.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Compute summary metrics
    const impactedEndpoints: Record<string, number> = {};
    const statusCodeDistribution: Record<number, number> = {};
    const exceptionMap: Map<string, { count: number; sample: string }> = new Map();

    for (const span of filtered) {
      impactedEndpoints[span.endpoint] = (impactedEndpoints[span.endpoint] || 0) + 1;
      statusCodeDistribution[span.statusCode] =
        (statusCodeDistribution[span.statusCode] || 0) + 1;

      const exType =
        (span.attributes['exception.type'] as string) ||
        (span.errorMessage ? span.errorMessage.split(':')[0] : 'UnknownException');

      const existing = exceptionMap.get(exType) || {
        count: 0,
        sample: span.errorMessage || 'No error message',
      };
      existing.count++;
      exceptionMap.set(exType, existing);
    }

    const commonExceptions = Array.from(exceptionMap.entries()).map(
      ([type, data]) => ({
        type,
        count: data.count,
        sampleMessage: data.sample,
      })
    );

    return {
      serviceName,
      minStatusCode,
      timeframeMinutes,
      summary: {
        totalMatchingSpans: filtered.length,
        impactedEndpoints,
        statusCodeDistribution,
        commonExceptions,
      },
      spans: filtered.slice(0, limit),
    };
  }

  public injectIncidentTraces(
    serviceName: string,
    incidentType: IncidentSimulationType,
    count: number = 6
  ): TraceSpan[] {
    logger.warn('Injecting simulated incident trace spans', {
      serviceName,
      incidentType,
      count,
    });

    const now = Date.now();
    const createdSpans: TraceSpan[] = [];

    for (let i = 0; i < count; i++) {
      const traceId = generateHex(16);
      const rootSpanId = generateHex(8);
      const childSpanId = generateHex(8);
      // Stagger within the last 5 minutes
      const spanTime = new Date(now - i * 45 * 1000).toISOString();

      let span: TraceSpan;

      switch (incidentType) {
        case 'db_connection_pool_exhaustion': {
          span = {
            traceId,
            spanId: childSpanId,
            parentSpanId: rootSpanId,
            serviceName,
            operationName: 'POST /api/v1/orders/checkout',
            endpoint: '/api/v1/orders/checkout',
            httpMethod: 'POST',
            statusCode: 500,
            durationMs: 8412 + Math.floor(Math.random() * 1200),
            timestamp: spanTime,
            errorMessage:
              'TimeoutError: ResourcePool timed out after 8000ms acquiring client connection. Max pool size (20) reached. Active clients: 20, Waiting clients: 74.',
            stackTrace: `TimeoutError: ResourcePool timed out after 8000ms acquiring client connection. Max pool size (20) reached.
    at Pool.acquire (src/database/connectionPool.ts:142:19)
    at DatabaseClient.query (src/database/dbClient.ts:78:28)
    at OrderRepository.createOrder (src/repositories/orderRepo.ts:45:31)
    at CheckoutService.processCheckout (src/services/checkoutService.ts:112:24)
    at async handleCheckout (src/controllers/orderController.ts:63:18)`,
            attributes: {
              'http.method': 'POST',
              'http.status_code': 500,
              'http.route': '/api/v1/orders/checkout',
              'db.system': 'postgresql',
              'db.name': 'production_orders',
              'db.pool.max': 20,
              'db.pool.active': 20,
              'db.pool.waiting': 74,
              'db.pool.timeout_ms': 8000,
              'exception.type': 'ConnectionTimeoutError',
              'exception.message':
                'ResourcePool timed out acquiring client connection (max: 20)',
            },
            events: [
              {
                name: 'pool_acquire_requested',
                timestamp: spanTime,
                attributes: { 'db.pool.waiting': 74 },
              },
              {
                name: 'pool_acquire_timeout',
                timestamp: new Date(new Date(spanTime).getTime() + 8000).toISOString(),
                attributes: { 'error.reason': 'connection_pool_exhausted' },
              },
            ],
          };
          break;
        }

        case 'high_5xx_spike': {
          span = {
            traceId,
            spanId: childSpanId,
            parentSpanId: rootSpanId,
            serviceName,
            operationName: 'POST /api/v1/payments/charge',
            endpoint: '/api/v1/payments/charge',
            httpMethod: 'POST',
            statusCode: 502,
            durationMs: 3200 + Math.floor(Math.random() * 400),
            timestamp: spanTime,
            errorMessage:
              'BadGatewayError: Upstream payment-gateway.internal timed out or returned ECONNRESET on socket connection',
            stackTrace: `BadGatewayError: Upstream payment-gateway.internal timed out or returned ECONNRESET
    at HttpClient.executeRequest (src/clients/httpEngine.ts:189:15)
    at PaymentClient.authorizePayment (src/clients/paymentClient.ts:54:21)
    at PaymentService.charge (src/services/paymentService.ts:88:12)
    at async processChargeRequest (src/controllers/paymentController.ts:41:9)`,
            attributes: {
              'http.method': 'POST',
              'http.status_code': 502,
              'http.route': '/api/v1/payments/charge',
              'net.peer.name': 'payment-gateway.internal',
              'exception.type': 'UpstreamConnectionResetError',
              'exception.message': 'Upstream socket reset by peer',
            },
            events: [
              {
                name: 'socket_connect_error',
                timestamp: spanTime,
                attributes: { error_code: 'ECONNRESET' },
              },
            ],
          };
          break;
        }

        case 'memory_leak': {
          span = {
            traceId,
            spanId: childSpanId,
            parentSpanId: rootSpanId,
            serviceName,
            operationName: 'GET /api/v1/analytics/export',
            endpoint: '/api/v1/analytics/export',
            httpMethod: 'GET',
            statusCode: 500,
            durationMs: 14500,
            timestamp: spanTime,
            errorMessage:
              'RangeError: Array buffer allocation failed (JavaScript heap out of memory)',
            stackTrace: `RangeError: Array buffer allocation failed
    at Buffer.allocUnsafe (node:buffer:392:5)
    at LargeExportWorker.serializeDataset (src/workers/exportWorker.ts:89:22)
    at AnalyticsController.exportData (src/controllers/analyticsController.ts:34:16)`,
            attributes: {
              'http.method': 'GET',
              'http.status_code': 500,
              'http.route': '/api/v1/analytics/export',
              'exception.type': 'OutOfMemoryError',
              'process.heap_used_mb': 1840,
            },
            events: [],
          };
          break;
        }

        case 'cpu_throttling': {
          span = {
            traceId,
            spanId: childSpanId,
            parentSpanId: rootSpanId,
            serviceName,
            operationName: 'POST /api/v1/inventory/reindex',
            endpoint: '/api/v1/inventory/reindex',
            httpMethod: 'POST',
            statusCode: 504,
            durationMs: 30000,
            timestamp: spanTime,
            errorMessage:
              'GatewayTimeout: CPU limit throttled. Node.js event loop lag exceeded 12500ms.',
            stackTrace: `GatewayTimeout: CPU limit throttled
    at EventLoopMonitor.checkLag (src/utils/eventLoop.ts:45:11)
    at RequestMiddleware.timeoutGuard (src/middleware/timeout.ts:28:14)`,
            attributes: {
              'http.method': 'POST',
              'http.status_code': 504,
              'http.route': '/api/v1/inventory/reindex',
              'exception.type': 'CpuThrottledTimeout',
            },
            events: [],
          };
          break;
        }
      }

      this.recordSpan(span);
      createdSpans.push(span);
    }

    return createdSpans;
  }
}

export const traceParser = new TraceParser();
