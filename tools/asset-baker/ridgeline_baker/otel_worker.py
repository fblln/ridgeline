"""OpenTelemetry tracing for the GPX worker.

No-op if OpenTelemetry isn't installed or OTEL_SDK_DISABLED=true, so the
exporter never blocks an asset build. Continues the trace started by the Node
API when a W3C `TRACEPARENT` env var is present, so a browser import shows up
as one trace: browser -> API -> worker -> external DEM/tile HTTP calls.
"""

import os
from contextlib import contextmanager

_tracer = None
_provider = None


def init_tracing():
    global _tracer, _provider
    if _tracer is not None or os.environ.get("OTEL_SDK_DISABLED") == "true":
        return _tracer
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.urllib import URLLibInstrumentor

        endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318").rstrip("/")
        service = os.environ.get("OTEL_SERVICE_NAME", "ridgeline-worker")
        _provider = TracerProvider(resource=Resource.create({"service.name": service}))
        _provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")))
        trace.set_tracer_provider(_provider)
        URLLibInstrumentor().instrument()  # each IGN / Piemonte / tile request becomes a child span
        _tracer = trace.get_tracer("ridgeline.worker")
    except Exception as exc:  # missing deps, bad endpoint — tracing is best-effort
        print(f"  otel disabled: {exc}")
    return _tracer


def _parent_context():
    tp = os.environ.get("TRACEPARENT")
    if not tp:
        return None
    try:
        from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

        return TraceContextTextMapPropagator().extract({"traceparent": tp})
    except Exception:
        return None


@contextmanager
def root_span(name, **attrs):
    """Top-level worker span; flushes the exporter on exit."""
    tracer = init_tracing()
    if tracer is None:
        yield None
        return
    parent = _parent_context()
    try:
        with tracer.start_as_current_span(name, context=parent) as span:
            for key, value in attrs.items():
                span.set_attribute(key, value)
            yield span
        # span has ended here; now it's safe to flush + shut the exporter down
    finally:
        if _provider is not None:
            _provider.force_flush()
            _provider.shutdown()


@contextmanager
def span(name, **attrs):
    """Child span for a build stage; no-op when tracing is off."""
    if _tracer is None:
        yield None
        return
    with _tracer.start_as_current_span(name) as s:
        for key, value in attrs.items():
            s.set_attribute(key, value)
        yield s


def run_in_span(name, fn, *args, **kwargs):
    """Run fn inside a named span so Jaeger shows a meaningful operation
    (e.g. 'topo-tile') instead of a generic auto-instrumented 'GET'."""
    if _tracer is None:
        return fn(*args, **kwargs)
    with _tracer.start_as_current_span(name):
        return fn(*args, **kwargs)


def context_binder():
    """Capture the current OTel context (call on the main thread) and return a
    decorator that runs a callable under it — so spans created in worker threads
    nest under the active build span. No-op if tracing isn't active."""
    if _tracer is None:
        return lambda fn: fn
    from opentelemetry import context as otel_context

    captured = otel_context.get_current()

    def bind(fn):
        def wrapped(*args, **kwargs):
            token = otel_context.attach(captured)
            try:
                return fn(*args, **kwargs)
            finally:
                otel_context.detach(token)

        return wrapped

    return bind
