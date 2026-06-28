// OpenTelemetry for the Vite dev API. Initialised once on import. Exports a
// tracer plus helpers to (a) continue the browser's trace from request headers
// and (b) hand the active span's context to the Python worker via TRACEPARENT.
import { context, propagation, trace, type Context, type Span } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318").replace(/\/$/, "");

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "ridgeline-api" }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))],
});
provider.register({ propagator: new W3CTraceContextPropagator() });

export const tracer = trace.getTracer("ridgeline.api");

const headerGetter = {
  keys: (carrier: Record<string, string | string[] | undefined>) => Object.keys(carrier),
  get: (carrier: Record<string, string | string[] | undefined>, key: string) => {
    const value = carrier[key];
    return Array.isArray(value) ? value[0] : value;
  },
};

/** Build a context from the browser's incoming traceparent header (if any). */
export function contextFromHeaders(headers: Record<string, string | string[] | undefined>): Context {
  return propagation.extract(context.active(), headers, headerGetter);
}

/** W3C traceparent string for a span, to pass to the worker as an env var. */
export function traceparentFor(span: Span): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpan(context.active(), span), carrier);
  return carrier.traceparent;
}
