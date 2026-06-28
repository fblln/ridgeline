// Browser tracing. Auto-instruments fetch, so the GPX upload POST starts a
// trace and injects W3C traceparent into /api/* — the Node API continues it and
// hands it to the Python worker. Exports to same-origin /v1/traces, which the
// Vite plugin proxies to the OTLP collector (avoids browser->collector CORS).
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const provider = new WebTracerProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "ridgeline-web" }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: "/v1/traces" }))],
});
provider.register({ propagator: new W3CTraceContextPropagator() });

registerInstrumentations({
  instrumentations: [
    new FetchInstrumentation({
      // Add traceparent to our API calls; never to the trace-export call itself.
      propagateTraceHeaderCorsUrls: [/\/api\//],
      ignoreUrls: [/\/v1\/traces$/],
    }),
  ],
});
