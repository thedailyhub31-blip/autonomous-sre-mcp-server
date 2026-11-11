import { z } from 'zod';
import { execSync } from 'node:child_process';
import { metricsEngine, MetricType, IncidentSimulationType } from '../telemetry/metricsEngine.js';
import { traceParser } from '../telemetry/traceParser.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// Git Deployment Metadata & Correlation Engine
// ============================================================================

export interface GitCommitRecord {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  timestamp: string; // ISO 8601
  message: string;
  changedFiles: string[];
  serviceName: string;
  suspectScore: number; // 0 to 100
  suspectReasons: string[];
}

export interface IncidentCorrelationResult {
  serviceName: string;
  incidentTimestamp: string;
  analysisWindowMinutes: number;
  totalCommitsInspected: number;
  suspectCommits: GitCommitRecord[];
  highestSuspect: GitCommitRecord | null;
  correlationSummary: string;
}

// In-memory deployment history representing CI/CD deployments for microservices
const deploymentHistory: GitCommitRecord[] = [];

// Seed default realistic recent microservice deployments
function seedDeploymentHistory() {
  const now = Date.now();
  deploymentHistory.length = 0; // reset

  deploymentHistory.push(
    {
      sha: 'a8f4c2918e7d45bb921c320e82aa619f7bc014a9',
      shortSha: 'a8f4c29',
      author: 'Alex Dev',
      email: 'alex.dev@corp.io',
      timestamp: new Date(now - 14 * 60 * 1000).toISOString(),
      message: 'perf(db): downscale connection pool max size to 20 to reduce idle postgres overhead',
      changedFiles: [
        'src/database/connectionPool.ts',
        'config/production.json',
        'k8s/order-service-deployment.yaml',
      ],
      serviceName: 'order-service',
      suspectScore: 95,
      suspectReasons: [
        'Deployed 14 minutes before incident onset',
        'Modified database connection pool settings (src/database/connectionPool.ts)',
        'Directly reduced max resource pool capacity',
      ],
    },
    {
      sha: 'b3e107df94cb41829e578c93b6e80b2a301e4a12',
      shortSha: 'b3e107d',
      author: 'Sarah Lead',
      email: 'sarah.lead@corp.io',
      timestamp: new Date(now - 45 * 60 * 1000).toISOString(),
      message: 'feat(cart): add promo code validation endpoint',
      changedFiles: [
        'src/controllers/promoController.ts',
        'src/services/promoService.ts',
      ],
      serviceName: 'order-service',
      suspectScore: 15,
      suspectReasons: ['Low blast radius controller changes, deployed 45m ago'],
    },
    {
      sha: 'f72a49cc8b7244519fa620e729a88e918c502b77',
      shortSha: 'f72a49c',
      author: 'David DevOps',
      email: 'david.infra@corp.io',
      timestamp: new Date(now - 22 * 60 * 1000).toISOString(),
      message: 'fix(networking): update upstream gateway keep-alive timeout to 1500ms',
      changedFiles: [
        'src/clients/httpEngine.ts',
        'helm/payment-gateway/values.yaml',
      ],
      serviceName: 'payment-gateway',
      suspectScore: 88,
      suspectReasons: [
        'Modified network keep-alive and socket timeout headers',
        'Deployed 22m before upstream socket drops',
      ],
    }
  );
}

seedDeploymentHistory();

/**
 * Inspects local git repository if available and merges commits into correlation analysis
 */
function inspectLocalGitCommits(sinceIso: string): GitCommitRecord[] {
  const records: GitCommitRecord[] = [];
  try {
    const rawLog = execSync(
      `git log --since="${sinceIso}" --pretty=format:"%H|%h|%an|%ae|%aI|%s" --name-only`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    );

    if (!rawLog.trim()) return records;

    const entries = rawLog.split('\n\n');
    for (const entry of entries) {
      const lines = entry.trim().split('\n');
      if (lines.length === 0 || !lines[0].includes('|')) continue;

      const [sha, shortSha, author, email, timestamp, message] = lines[0].split('|');
      const changedFiles = lines.slice(1).map((f) => f.trim()).filter(Boolean);

      records.push({
        sha: sha || '',
        shortSha: shortSha || '',
        author: author || 'Unknown',
        email: email || '',
        timestamp: timestamp || new Date().toISOString(),
        message: message || '',
        changedFiles,
        serviceName: 'order-service',
        suspectScore: 50,
        suspectReasons: ['Local workspace git commit in incident window'],
      });
    }
  } catch {
    // Git command not available or not git repo; ignore gracefully
  }
  return records;
}

// ============================================================================
// SRE MCP Tool Schemas (Zod)
// ============================================================================

export const QueryServiceMetricsSchema = {
  serviceName: z
    .string()
    .describe('The target microservice name (e.g. "order-service", "payment-gateway")'),
  metricType: z
    .enum(['cpu', 'memory', 'error_rate', 'latency_p99'])
    .describe('Telemetry metric to query'),
  timeframeMinutes: z
    .number()
    .min(1)
    .max(180)
    .optional()
    .default(15)
    .describe('Lookback window in minutes (1 to 180, default 15)'),
};

export const FetchErrorTracesSchema = {
  serviceName: z
    .string()
    .describe('The target microservice name (e.g. "order-service", "payment-gateway")'),
  minStatusCode: z
    .number()
    .optional()
    .default(500)
    .describe('Minimum HTTP status code threshold (e.g. 500 for server errors)'),
  timeframeMinutes: z
    .number()
    .optional()
    .default(30)
    .describe('Lookback timeframe in minutes (default 30)'),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe('Maximum number of trace spans to return (default 10)'),
};

export const CorrelateIncidentWithGitSchema = {
  timestampIso: z
    .string()
    .describe('ISO 8601 timestamp representing the incident detection or peak time'),
  serviceName: z
    .string()
    .describe('Target microservice that experienced the incident'),
  windowMinutes: z
    .number()
    .optional()
    .default(60)
    .describe('Analysis window in minutes prior to the incident timestamp (default 60)'),
};

export const GenerateIncidentSummarySchema = {
  serviceName: z
    .string()
    .describe('The primary microservice affected by the incident'),
  incidentTimestampIso: z
    .string()
    .optional()
    .describe('Optional incident timestamp. Defaults to current time.'),
  lookbackMinutes: z
    .number()
    .optional()
    .default(30)
    .describe('Diagnostics window in minutes (default 30)'),
};

export const SimulateIncidentEventSchema = {
  serviceName: z
    .string()
    .describe('Service name to target (e.g. "order-service")'),
  incidentType: z
    .enum([
      'db_connection_pool_exhaustion',
      'high_5xx_spike',
      'memory_leak',
      'cpu_throttling',
    ])
    .describe('Synthetic incident scenario to inject'),
  severity: z
    .enum(['warning', 'critical'])
    .optional()
    .default('critical')
    .describe('Severity level of the injected failure (default "critical")'),
};

// ============================================================================
// Tool Implementation Handlers
// ============================================================================

export async function handleQueryServiceMetrics(args: {
  serviceName: string;
  metricType: MetricType;
  timeframeMinutes?: number;
}) {
  const timeframe = args.timeframeMinutes ?? 15;
  const result = metricsEngine.queryMetrics(
    args.serviceName,
    args.metricType,
    timeframe
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

export async function handleFetchErrorTraces(args: {
  serviceName: string;
  minStatusCode?: number;
  timeframeMinutes?: number;
  limit?: number;
}) {
  const minCode = args.minStatusCode ?? 500;
  const timeframe = args.timeframeMinutes ?? 30;
  const limit = args.limit ?? 10;

  const result = traceParser.fetchErrorTraces(
    args.serviceName,
    minCode,
    timeframe,
    limit
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

export async function handleCorrelateIncidentWithGit(args: {
  timestampIso: string;
  serviceName: string;
  windowMinutes?: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const windowMins = args.windowMinutes ?? 60;
  const targetTime = new Date(args.timestampIso).getTime();
  const startTime = targetTime - windowMins * 60 * 1000;

  // Filter deployment commits matching service within window
  const matchingDeployments = deploymentHistory.filter((c) => {
    const cTime = new Date(c.timestamp).getTime();
    const serviceMatch =
      c.serviceName.toLowerCase() === args.serviceName.toLowerCase();
    return serviceMatch && cTime >= startTime && cTime <= targetTime + 5 * 60 * 1000;
  });

  // Check local git repository
  const sinceIso = new Date(startTime).toISOString();
  const localCommits = inspectLocalGitCommits(sinceIso);
  const allCommits = [...matchingDeployments, ...localCommits];

  // Score commits based on recency and sensitive file keywords
  const sensitivePatterns = [
    /pool/i,
    /connection/i,
    /timeout/i,
    /config/i,
    /database/i,
    /k8s/i,
    /helm/i,
    /cache/i,
  ];

  const scoredCommits = allCommits.map((commit) => {
    let score = commit.suspectScore || 20;
    const commitTime = new Date(commit.timestamp).getTime();
    const diffMinutes = Math.abs((targetTime - commitTime) / (60 * 1000));

    // Closeness in time increases score
    if (diffMinutes <= 15) score += 25;
    else if (diffMinutes <= 30) score += 15;

    // Sensitive files
    const touchedSensitive = commit.changedFiles.some((f) =>
      sensitivePatterns.some((pattern) => pattern.test(f))
    );
    if (touchedSensitive) score += 25;

    // Message keywords
    if (sensitivePatterns.some((p) => p.test(commit.message))) {
      score += 20;
    }

    const finalScore = Math.min(100, Math.max(10, score));

    const reasons = [...commit.suspectReasons];
    if (diffMinutes <= 15 && !reasons.some((r) => r.includes('minutes before'))) {
      reasons.push(`Deployed ${Math.round(diffMinutes)} minutes prior to incident`);
    }
    if (touchedSensitive && !reasons.some((r) => r.includes('infrastructure or connection'))) {
      reasons.push('Modified sensitive database/network infrastructure files');
    }

    return {
      ...commit,
      suspectScore: finalScore,
      suspectReasons: reasons,
    };
  });

  // Sort by suspect score descending
  scoredCommits.sort((a, b) => b.suspectScore - a.suspectScore);

  const highestSuspect = scoredCommits.length > 0 ? scoredCommits[0] : null;

  const result: IncidentCorrelationResult = {
    serviceName: args.serviceName,
    incidentTimestamp: args.timestampIso,
    analysisWindowMinutes: windowMins,
    totalCommitsInspected: scoredCommits.length,
    suspectCommits: scoredCommits,
    highestSuspect,
    correlationSummary: highestSuspect
      ? `High correlation found: Commit ${highestSuspect.shortSha} ("${highestSuspect.message}") by ${highestSuspect.author} deployed ~${Math.round(Math.abs((targetTime - new Date(highestSuspect.timestamp).getTime()) / 60000))}m before incident (Suspect Score: ${highestSuspect.suspectScore}%).`
      : 'No suspicious deployments detected within the analysis window.',
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

export async function handleGenerateIncidentSummary(args: {
  serviceName: string;
  incidentTimestampIso?: string;
  lookbackMinutes?: number;
}) {
  const serviceName = args.serviceName;
  const timestamp = args.incidentTimestampIso || new Date().toISOString();
  const lookback = args.lookbackMinutes ?? 30;

  // 1. Gather Telemetry: Metrics
  const errorRateData = metricsEngine.queryMetrics(serviceName, 'error_rate', lookback);
  const latencyData = metricsEngine.queryMetrics(serviceName, 'latency_p99', lookback);
  const cpuData = metricsEngine.queryMetrics(serviceName, 'cpu', lookback);
  const memoryData = metricsEngine.queryMetrics(serviceName, 'memory', lookback);

  // 2. Gather Telemetry: Error Traces
  const traceData = traceParser.fetchErrorTraces(serviceName, 500, lookback, 10);

  // 3. Correlate with Git deployments
  const correlationResponse = await handleCorrelateIncidentWithGit({
    serviceName,
    timestampIso: timestamp,
    windowMinutes: lookback * 2,
  });
  const correlation: IncidentCorrelationResult = JSON.parse(
    correlationResponse.content[0].text
  );

  // 4. Determine Severity
  const isCritical =
    errorRateData.summary.current >= 10 ||
    latencyData.summary.current >= 2000 ||
    traceData.summary.totalMatchingSpans >= 5;
  const severity = isCritical ? 'SEV-1 (CRITICAL)' : 'SEV-2 (HIGH)';

  // 5. Synthesize Root Cause Hypothesis
  let rootCause = 'Telemetry anomalies detected with service degradation.';
  const suspectCommit = correlation.highestSuspect;

  if (traceData.summary.commonExceptions.length > 0) {
    const topException = traceData.summary.commonExceptions[0];
    if (topException.type.includes('ConnectionTimeout') || topException.sampleMessage.includes('pool')) {
      rootCause = `Database connection pool starvation. Active connections saturated the configured limit, leading to client acquisition timeouts (HTTP 500) and cascading request backpressure.`;
      if (suspectCommit) {
        rootCause += ` Strongly correlated with deployment of commit ${suspectCommit.shortSha} which altered connection pool sizing.`;
      }
    } else if (topException.type.includes('OutOfMemory') || memoryData.summary.current > 800) {
      rootCause = `Memory leak / heap exhaustion causing catastrophic V8 GC pauses and node process degradation.`;
    } else if (topException.sampleMessage.includes('BadGateway') || topException.sampleMessage.includes('ECONNRESET')) {
      rootCause = `Upstream network dependency failure or keep-alive socket drop causing cascading 502 Bad Gateway responses.`;
    } else {
      rootCause = `Unhandled server exceptions detected: ${topException.sampleMessage}`;
    }
  }

  // 6. Recommended Remediation Plan
  const immediateActions: string[] = [];
  const postMortemActions: string[] = [];

  if (suspectCommit) {
    immediateActions.push(
      `Trigger immediate rollback of deployment: \`git revert ${suspectCommit.shortSha} && git push origin main\``,
      `Or roll back Kubernetes deployment revision: \`kubectl rollout undo deployment/${serviceName}\``
    );
  } else {
    immediateActions.push(
      `Restart service replicas to restore healthy operational state: \`kubectl rollout restart deployment/${serviceName}\``
    );
  }

  if (rootCause.includes('connection pool')) {
    immediateActions.push(
      'Temporarily scale up database pool size in environment config (e.g. `DB_POOL_MAX=50`).'
    );
    postMortemActions.push(
      'Implement PgBouncer or AWS RDS Proxy connection pooling layer.',
      'Add Prometheus connection pool saturation alert at 80% capacity utilization.',
      'Audit long-running database queries and missing transaction commit/rollback calls.'
    );
  } else {
    immediateActions.push(
      'Increase container memory and CPU limits in Helm values.',
      'Enable circuit breaker pattern on upstream HTTP client calls.'
    );
    postMortemActions.push(
      'Set up synthetic canary probe to validate latency SLA (< 200ms).',
      'Establish automated canary deployment analysis with Flagger.'
    );
  }

  // 7. Generate Formatted Diagnostic Report
  const markdownReport = `
# 🚨 INCIDENT DIAGNOSTIC REPORT: ${serviceName.toUpperCase()}
**Incident Timestamp:** \`${timestamp}\`  
**Classification:** **${severity}**  
**Status:** ACTIVE INVESTIGATION  

---

### 1. Executive Summary
During the past ${lookback} minutes, **${serviceName}** experienced severe degradation.
- **Current Error Rate:** \`${errorRateData.summary.current}%\` (Baseline: \`${errorRateData.summary.baselineMean}%\`, Peak: \`${errorRateData.summary.max}%\`)
- **P99 Latency:** \`${latencyData.summary.current}ms\` (Baseline: \`${latencyData.summary.baselineMean}ms\`, Peak: \`${latencyData.summary.max}ms\`)
- **Total Failing Spans Captured:** \`${traceData.summary.totalMatchingSpans}\`

---

### 2. Suspected Root Cause
> ${rootCause}

${suspectCommit ? `
#### Correlated Deployment
- **Commit SHA:** \`${suspectCommit.sha}\` (\`${suspectCommit.shortSha}\`)
- **Author:** ${suspectCommit.author} <${suspectCommit.email}>
- **Message:** "${suspectCommit.message}"
- **Suspect Confidence Score:** **${suspectCommit.suspectScore}%**
- **Modified Files:**
${suspectCommit.changedFiles.map((f) => `  - \`${f}\``).join('\n')}
- **Correlation Evidence:**
${suspectCommit.suspectReasons.map((r) => `  - ${r}`).join('\n')}
` : '_No suspicious recent Git commits identified within lookback window._'}

---

### 3. OpenTelemetry Error Trace Evidence
${traceData.spans.length > 0 ? `
**Sample Failing Span:**
- **Trace ID:** \`${traceData.spans[0].traceId}\`
- **Span ID:** \`${traceData.spans[0].spanId}\`
- **Endpoint:** \`${traceData.spans[0].httpMethod} ${traceData.spans[0].endpoint}\`
- **Status Code:** \`${traceData.spans[0].statusCode}\`
- **Error:** \`${traceData.spans[0].errorMessage}\`

\`\`\`typescript
${traceData.spans[0].stackTrace || 'No stack trace provided'}
\`\`\`
` : '_No error spans recorded._'}

---

### 4. Immediate Remediation Runbook
${immediateActions.map((action, i) => `${i + 1}. ${action}`).join('\n')}

---

### 5. Preventative Post-Mortem Recommendations
${postMortemActions.map((action, i) => `- ${action}`).join('\n')}
`.trim();

  const reportPayload = {
    incidentTitle: `Incident in ${serviceName} - ${severity}`,
    severity,
    serviceName,
    timestamp,
    lookbackMinutes: lookback,
    metricsSummary: {
      errorRate: errorRateData.summary,
      latencyP99: latencyData.summary,
      cpu: cpuData.summary,
      memory: memoryData.summary,
    },
    traceSummary: traceData.summary,
    correlatedDeployment: suspectCommit,
    rootCauseHypothesis: rootCause,
    remediationSteps: immediateActions,
    postMortemActions,
    diagnosticMarkdown: markdownReport,
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(reportPayload, null, 2),
      },
    ],
  };
}

export async function handleSimulateIncidentEvent(args: {
  serviceName: string;
  incidentType: IncidentSimulationType;
  severity?: 'warning' | 'critical';
}) {
  const severity = args.severity ?? 'critical';

  logger.warn('Triggering synthetic incident event simulation', {
    serviceName: args.serviceName,
    incidentType: args.incidentType,
    severity,
  });

  // 1. Inject Metric Spikes
  metricsEngine.injectMetricSpike(args.serviceName, args.incidentType, severity, 10);

  // 2. Inject OpenTelemetry Error Trace Spans
  const createdSpans = traceParser.injectIncidentTraces(
    args.serviceName,
    args.incidentType,
    6
  );

  // 3. Ensure a correlated deployment commit exists
  seedDeploymentHistory();

  const response = {
    status: 'INJECTED',
    message: `Synthetic incident "${args.incidentType}" (${severity}) successfully triggered on service "${args.serviceName}".`,
    injectedMetrics: {
      service: args.serviceName,
      metricSpikeMinutes: 10,
      severity,
    },
    injectedErrorSpans: createdSpans.map((s) => ({
      traceId: s.traceId,
      spanId: s.spanId,
      endpoint: s.endpoint,
      statusCode: s.statusCode,
      errorMessage: s.errorMessage,
    })),
    nextSteps: [
      `Call query_service_metrics to inspect the telemetry anomaly spikes.`,
      `Call fetch_error_traces to review OpenTelemetry error stack traces.`,
      `Call correlate_incident_with_git to identify suspect deployment commits.`,
      `Call generate_incident_summary to obtain a complete diagnostic report with remediation commands.`,
    ],
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(response, null, 2),
      },
    ],
  };
}
