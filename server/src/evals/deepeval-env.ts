/**
 * Side-effect module: set DeepEval's environment before DeepEval loads.
 *
 * DeepEval ships PostHog product analytics, a New Relic OTLP span exporter and
 * an optional Sentry client. Today it reads the opt-out lazily, so setting the
 * variable anywhere before the first metric runs happens to work — but that is
 * a property of their current implementation, not a promise, and an eval
 * harness reporting on a deliberately local, no-paid-API pipeline should not
 * be the one component quietly making outbound calls.
 *
 * So this is imported FIRST — above the deepeval imports — in every module
 * that touches the library. `??=` so an operator who genuinely wants to send
 * telemetry can still set it to "NO" and be obeyed.
 */
process.env.DEEPEVAL_TELEMETRY_OPT_OUT ??= "YES";

/** Their error reporting is off unless asked for; make that explicit too. */
process.env.ERROR_REPORTING ??= "NO";

export {};
