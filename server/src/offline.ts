/** Apply before evaluator/tracing imports. Operator env cannot opt into telemetry. */
process.env.DEEPEVAL_TELEMETRY_OPT_OUT = "YES";
process.env.ERROR_REPORTING = "NO";
process.env.LANGCHAIN_TRACING_V2 = "false";
process.env.LANGSMITH_TRACING = "false";
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";
// Telemetry opt-out alone does not disable authenticated DeepEval uploads.
delete process.env.CONFIDENT_API_KEY;
process.env.CONFIDENT_BASE_URL = "http://127.0.0.1:1";

export function localTraceEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
