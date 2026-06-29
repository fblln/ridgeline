use std::collections::HashMap;
use std::time::Duration;

use opentelemetry::global;
use opentelemetry::propagation::TextMapPropagator;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing::Span;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::Registry;
use tracing_subscriber::layer::SubscriberExt;

pub struct TraceGuard {
    provider: Option<SdkTracerProvider>,
}

impl TraceGuard {
    pub fn shutdown(&self) {
        if let Some(provider) = &self.provider {
            let _ = provider.force_flush();
            let _ = provider.shutdown_with_timeout(Duration::from_secs(2));
        }
    }
}

impl Drop for TraceGuard {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn init(service_name: &str) -> TraceGuard {
    global::set_text_map_propagator(TraceContextPropagator::new());

    let has_export_endpoint = std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").is_ok()
        || std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").is_ok();
    let sdk_disabled = matches!(
        std::env::var("OTEL_SDK_DISABLED").ok().as_deref(),
        Some("1" | "true" | "yes")
    );
    if sdk_disabled || !has_export_endpoint {
        return TraceGuard { provider: None };
    }

    match build_provider(service_name) {
        Ok(provider) => {
            let tracer = provider.tracer("ridgeline-baker");
            let subscriber =
                Registry::default().with(tracing_opentelemetry::layer().with_tracer(tracer));
            if tracing::subscriber::set_global_default(subscriber).is_ok() {
                TraceGuard {
                    provider: Some(provider),
                }
            } else {
                TraceGuard { provider: None }
            }
        }
        Err(error) => {
            eprintln!("Warning: OpenTelemetry disabled: {error}");
            TraceGuard { provider: None }
        }
    }
}

pub fn root_span(name: &'static str) -> Span {
    let span = match name {
        "build-assets" => tracing::info_span!("build-assets"),
        "import-job" => tracing::info_span!("import-job"),
        _ => tracing::info_span!("span", otel.name = name),
    };

    if let Some(parent) = parent_context_from_env() {
        let _ = span.set_parent(parent);
    }
    span
}

fn build_provider(service_name: &str) -> anyhow::Result<SdkTracerProvider> {
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").or_else(|_| {
        std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").map(|base| endpoint_from_base(&base))
    })?;

    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .with_protocol(Protocol::HttpBinary)
        .with_timeout(Duration::from_secs(3))
        .build()?;

    let service_name =
        std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| service_name.to_string());
    Ok(SdkTracerProvider::builder()
        .with_simple_exporter(exporter)
        .with_resource(Resource::builder().with_service_name(service_name).build())
        .build())
}

fn parent_context_from_env() -> Option<opentelemetry::Context> {
    let traceparent = std::env::var("TRACEPARENT").ok()?;
    let mut carrier = HashMap::new();
    carrier.insert("traceparent".to_string(), traceparent);
    if let Ok(tracestate) = std::env::var("TRACESTATE") {
        carrier.insert("tracestate".to_string(), tracestate);
    }
    let propagator = TraceContextPropagator::new();
    Some(propagator.extract(&carrier))
}

fn endpoint_from_base(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/v1/traces") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1/traces")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvGuard {
        saved: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvGuard {
        fn set(pairs: &[(&'static str, &str)]) -> Self {
            let mut saved = Vec::with_capacity(pairs.len());
            for &(name, value) in pairs {
                saved.push((name, std::env::var_os(name)));
                unsafe { std::env::set_var(name, value) };
            }
            Self { saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (name, value) in self.saved.drain(..).rev() {
                match value {
                    Some(value) => unsafe { std::env::set_var(name, value) },
                    None => unsafe { std::env::remove_var(name) },
                }
            }
        }
    }

    #[test]
    fn endpoint_from_base_appends_suffix_once() {
        assert_eq!(
            endpoint_from_base("http://localhost:4318"),
            "http://localhost:4318/v1/traces"
        );
        assert_eq!(
            endpoint_from_base("http://localhost:4318/"),
            "http://localhost:4318/v1/traces"
        );
        assert_eq!(
            endpoint_from_base("http://localhost:4318/v1/traces"),
            "http://localhost:4318/v1/traces"
        );
    }

    #[test]
    fn parent_context_reads_trace_headers_from_env() {
        let _guard = env_lock().lock().unwrap();
        let _env = EnvGuard::set(&[
            (
                "TRACEPARENT",
                "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            ),
            ("TRACESTATE", "congo=t61rcWkgMzE"),
        ]);
        assert!(parent_context_from_env().is_some());
        let _ = root_span("build-assets");
        let _ = root_span("import-job");
        let _ = root_span("custom-span");
    }

    #[test]
    fn init_disables_sdk_without_endpoint_or_when_forced_off() {
        let _guard = env_lock().lock().unwrap();
        let _env = EnvGuard::set(&[("OTEL_SDK_DISABLED", "true")]);
        let guard = init("ridgeline-test");
        assert!(guard.provider.is_none());

        drop(_env);
        let guard = init("ridgeline-test");
        assert!(guard.provider.is_none());
    }

    #[test]
    fn build_provider_uses_env_endpoint_and_service_name() {
        let _guard = env_lock().lock().unwrap();
        let _env = EnvGuard::set(&[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318"),
            ("OTEL_SERVICE_NAME", "override-service"),
        ]);
        let provider = build_provider("fallback-service").unwrap();
        let guard = TraceGuard {
            provider: Some(provider),
        };
        guard.shutdown();
    }
}
