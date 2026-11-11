#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  QueryServiceMetricsSchema,
  FetchErrorTracesSchema,
  CorrelateIncidentWithGitSchema,
  GenerateIncidentSummarySchema,
  SimulateIncidentEventSchema,
  handleQueryServiceMetrics,
  handleFetchErrorTraces,
  handleCorrelateIncidentWithGit,
  handleGenerateIncidentSummary,
  handleSimulateIncidentEvent,
} from './tools/sreTools.js';
import { logger } from './utils/logger.js';

async function main() {
  logger.info('Initializing Autonomous SRE Incident Diagnosis MCP Server...');

  const server = new McpServer({
    name: 'sre-incident-diagnosis-server',
    version: '1.0.0',
  });

  // Tool 1: Query Service Metrics
  server.tool(
    'query_service_metrics',
    'Query time-series telemetry metrics (CPU, RAM, 5xx error rates, P99 latency) and detect statistical anomaly spikes.',
    QueryServiceMetricsSchema,
    handleQueryServiceMetrics
  );

  // Tool 2: Fetch Error Traces
  server.tool(
    'fetch_error_traces',
    'Fetch structured OpenTelemetry error traces including traceId, spanId, HTTP status codes, error messages, and stack traces.',
    FetchErrorTracesSchema,
    handleFetchErrorTraces
  );

  // Tool 3: Correlate Incident with Git
  server.tool(
    'correlate_incident_with_git',
    'Correlate an incident timestamp and affected service with recent Git commits and deployments to identify suspect changes.',
    CorrelateIncidentWithGitSchema,
    handleCorrelateIncidentWithGit
  );

  // Tool 4: Generate Incident Summary
  server.tool(
    'generate_incident_summary',
    'Synthesize metrics, OpenTelemetry error traces, and correlated Git commits into an SRE incident diagnostic report with remediation runbooks.',
    GenerateIncidentSummarySchema,
    handleGenerateIncidentSummary
  );

  // Tool 5: Simulate Incident Event
  server.tool(
    'simulate_incident_event',
    'Inject a synthetic distributed incident (e.g. db connection pool exhaustion, 5xx spike, memory leak) for testing and evaluation.',
    SimulateIncidentEventSchema,
    handleSimulateIncidentEvent
  );

  // Set up stdio transport
  const transport = new StdioServerTransport();

  // Graceful shutdown handling
  let isClosing = false;
  const gracefulShutdown = async (signal: string) => {
    if (isClosing) return;
    isClosing = true;
    logger.info(`Received ${signal}. Shutting down MCP Server gracefully...`);

    try {
      await server.close();
      logger.info('MCP Server closed cleanly.');
    } catch (err) {
      logger.error('Error during MCP server shutdown', { error: String(err) });
    } finally {
      logger.close();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception caught in server process', { error: err.stack || err.message });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection caught in server process', { reason });
  });

  // Connect to stdio transport
  await server.connect(transport);
  logger.info('SRE MCP Server successfully connected to stdio transport. Ready for JSON-RPC messages.');
}

main().catch((err) => {
  logger.error('Fatal initialization error in MCP Server', { error: err.stack || err.message });
  process.exit(1);
});
