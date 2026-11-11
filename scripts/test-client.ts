import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const serverEntryPath = path.join(projectRoot, 'dist', 'index.js');

interface TextContent {
  type: 'text';
  text: string;
}

function parseToolResponse<T = any>(result: any): T {
  if (!result || !result.content || result.content.length === 0) {
    throw new Error('Tool returned empty response content');
  }
  const textContent = result.content.find((c: any) => c.type === 'text') as TextContent;
  if (!textContent) {
    throw new Error('No text content block found in tool response');
  }
  return JSON.parse(textContent.text);
}

function printSection(title: string) {
  console.log(`\n======================================================================`);
  console.log(`📌 ${title}`);
  console.log(`======================================================================`);
}

async function runSreTestHarness() {
  console.log('🚀 Starting Autonomous SRE MCP Server Automated Test Harness...');
  console.log(`Target Server Script: ${serverEntryPath}`);

  // Create StdioClientTransport pointing to the compiled Node.js server
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverEntryPath],
  });

  const client = new Client(
    {
      name: 'sre-verification-test-client',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  try {
    // 1. Connect over stdio
    console.log('Connecting to MCP Server over Stdio transport...');
    await client.connect(transport);
    console.log('✅ Connected successfully to MCP Server!');

    // 2. Verify List of Tools
    printSection('TEST 1: LIST REGISTERED MCP TOOLS');
    const toolsResponse = await client.listTools();
    const toolNames = toolsResponse.tools.map((t) => t.name);
    console.log(`Found ${toolNames.length} registered tools:`);
    toolNames.forEach((name) => console.log(`  - 🛠️  ${name}`));

    const expectedTools = [
      'query_service_metrics',
      'fetch_error_traces',
      'correlate_incident_with_git',
      'generate_incident_summary',
      'simulate_incident_event',
    ];

    for (const expected of expectedTools) {
      if (!toolNames.includes(expected)) {
        throw new Error(`Missing expected tool: ${expected}`);
      }
    }
    console.log('✅ All 5 core SRE tools verified and present in server registry!');

    // 3. Inject Simulated Incident
    printSection('TEST 2: SIMULATE INCIDENT EVENT');
    const targetService = 'order-service';
    console.log(`Injecting "db_connection_pool_exhaustion" incident into "${targetService}"...`);

    const injectResult = await client.callTool({
      name: 'simulate_incident_event',
      arguments: {
        serviceName: targetService,
        incidentType: 'db_connection_pool_exhaustion',
        severity: 'critical',
      },
    });

    const injectData = parseToolResponse(injectResult);
    console.log('Injection Status:', injectData.status);
    console.log('Message:', injectData.message);
    console.log(`Injected Error Spans Count: ${injectData.injectedErrorSpans?.length}`);
    if (injectData.status !== 'INJECTED' || !injectData.injectedErrorSpans?.length) {
      throw new Error('Simulated incident injection failed or returned no spans');
    }
    console.log('✅ Incident injection verified!');

    // 4. Query Telemetry Metrics
    printSection('TEST 3: QUERY SERVICE METRICS (ANOMALY DETECTION)');
    console.log(`Querying "error_rate" metrics for "${targetService}"...`);
    const errorMetricsResult = await client.callTool({
      name: 'query_service_metrics',
      arguments: {
        serviceName: targetService,
        metricType: 'error_rate',
        timeframeMinutes: 15,
      },
    });

    const errorMetrics = parseToolResponse(errorMetricsResult);
    console.log(`Current Error Rate: ${errorMetrics.summary.current}%`);
    console.log(`Baseline Mean: ${errorMetrics.summary.baselineMean}% | Max Peak: ${errorMetrics.summary.max}%`);
    console.log(`Anomalies Detected: ${errorMetrics.anomaliesDetected.length}`);
    if (errorMetrics.anomaliesDetected.length > 0) {
      console.log(`First Anomaly Alert: ${errorMetrics.anomaliesDetected[0].description}`);
    }

    console.log(`\nQuerying "latency_p99" metrics for "${targetService}"...`);
    const latencyMetricsResult = await client.callTool({
      name: 'query_service_metrics',
      arguments: {
        serviceName: targetService,
        metricType: 'latency_p99',
        timeframeMinutes: 15,
      },
    });
    const latencyMetrics = parseToolResponse(latencyMetricsResult);
    console.log(`Current P99 Latency: ${latencyMetrics.summary.current}ms`);
    console.log(`Baseline Mean: ${latencyMetrics.summary.baselineMean}ms | Max Peak: ${latencyMetrics.summary.max}ms`);
    console.log(`Anomalies Detected: ${latencyMetrics.anomaliesDetected.length}`);

    if (errorMetrics.anomaliesDetected.length === 0 || latencyMetrics.anomaliesDetected.length === 0) {
      throw new Error('Metrics engine failed to detect anomalous spikes after incident simulation');
    }
    console.log('✅ Telemetry metric anomaly detection verified!');

    // 5. Fetch Error Traces
    printSection('TEST 4: FETCH OPENTELEMETRY ERROR TRACES');
    console.log(`Fetching spans with statusCode >= 500 for "${targetService}"...`);
    const tracesResult = await client.callTool({
      name: 'fetch_error_traces',
      arguments: {
        serviceName: targetService,
        minStatusCode: 500,
        timeframeMinutes: 30,
        limit: 5,
      },
    });

    const tracesData = parseToolResponse(tracesResult);
    console.log(`Total Failing Spans: ${tracesData.summary.totalMatchingSpans}`);
    console.log('Impacted Endpoints:', tracesData.summary.impactedEndpoints);
    console.log('Common Exceptions:', tracesData.summary.commonExceptions);

    if (tracesData.spans.length > 0) {
      const sample = tracesData.spans[0];
      console.log('\nSample Captured Span:');
      console.log(`  - TraceId: ${sample.traceId}`);
      console.log(`  - SpanId: ${sample.spanId}`);
      console.log(`  - Endpoint: ${sample.httpMethod} ${sample.endpoint} (${sample.statusCode})`);
      console.log(`  - Error: ${sample.errorMessage}`);
      console.log(`  - Duration: ${sample.durationMs}ms`);
    } else {
      throw new Error('No error trace spans were retrieved');
    }
    console.log('✅ OpenTelemetry error trace indexing & retrieval verified!');

    // 6. Correlate with Git Commits
    printSection('TEST 5: CORRELATE INCIDENT WITH GIT DEPLOYMENTS');
    const incidentTimestamp = new Date().toISOString();
    console.log(`Correlating "${targetService}" at timestamp ${incidentTimestamp}...`);

    const gitResult = await client.callTool({
      name: 'correlate_incident_with_git',
      arguments: {
        serviceName: targetService,
        timestampIso: incidentTimestamp,
        windowMinutes: 60,
      },
    });

    const gitData = parseToolResponse(gitResult);
    console.log(`Total Commits Inspected: ${gitData.totalCommitsInspected}`);
    console.log('Correlation Summary:', gitData.correlationSummary);

    if (gitData.highestSuspect) {
      const suspect = gitData.highestSuspect;
      console.log(`\n🎯 Highest Suspect Commit Identified:`);
      console.log(`  - Commit SHA: ${suspect.sha} (${suspect.shortSha})`);
      console.log(`  - Author: ${suspect.author} <${suspect.email}>`);
      console.log(`  - Message: ${suspect.message}`);
      console.log(`  - Suspect Score: ${suspect.suspectScore}%`);
      console.log(`  - Changed Files: ${suspect.changedFiles.join(', ')}`);
      console.log(`  - Evidence: ${suspect.suspectReasons.join('; ')}`);
    } else {
      throw new Error('Failed to correlate incident with suspect Git deployment');
    }
    console.log('✅ Git commit correlation verified!');

    // 7. Generate Incident Diagnostic Summary
    printSection('TEST 6: GENERATE SRE INCIDENT DIAGNOSTIC SUMMARY');
    console.log(`Generating comprehensive incident summary for "${targetService}"...`);

    const summaryResult = await client.callTool({
      name: 'generate_incident_summary',
      arguments: {
        serviceName: targetService,
        incidentTimestampIso: incidentTimestamp,
        lookbackMinutes: 30,
      },
    });

    const summaryData = parseToolResponse(summaryResult);
    console.log(`Title: ${summaryData.incidentTitle}`);
    console.log(`Severity: ${summaryData.severity}`);
    console.log(`Root Cause Hypothesis:\n  ${summaryData.rootCauseHypothesis}`);
    console.log(`\nRemediation Steps:`);
    summaryData.remediationSteps.forEach((step: string, idx: number) => {
      console.log(`  ${idx + 1}. ${step}`);
    });

    console.log(`\nPost-Mortem Actions:`);
    summaryData.postMortemActions.forEach((action: string) => {
      console.log(`  * ${action}`);
    });

    console.log('\n--- MARKDOWN REPORT PREVIEW ---');
    console.log(summaryData.diagnosticMarkdown.slice(0, 700) + '\n...[truncated]');

    if (!summaryData.rootCauseHypothesis || summaryData.remediationSteps.length === 0) {
      throw new Error('Incident summary did not generate valid root-cause or remediation steps');
    }
    console.log('\n✅ Incident diagnostic summary generation verified!');

    printSection('🏆 ALL AUTOMATED TESTS PASSED SUCCESSFULLY');
    console.log('All 5 core MCP tools are functioning end-to-end over stdio JSON-RPC protocol.');

  } finally {
    console.log('\nClosing MCP client connection...');
    await client.close();
    console.log('Test run finished.');
  }
}

runSreTestHarness().catch((err) => {
  console.error('\n❌ Test harness failed with error:', err);
  process.exit(1);
});
