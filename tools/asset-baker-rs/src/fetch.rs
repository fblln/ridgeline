use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use anyhow::Context;

const DEFAULT_BODY_LIMIT: u64 = 512 * 1024 * 1024;

pub fn download(url: &str, headers: &[(&str, &str)], timeout_secs: u64) -> anyhow::Result<Vec<u8>> {
    download_limited(url, headers, timeout_secs, DEFAULT_BODY_LIMIT)
}

pub fn download_limited(
    url: &str,
    headers: &[(&str, &str)],
    timeout_secs: u64,
    limit: u64,
) -> anyhow::Result<Vec<u8>> {
    tracing::info_span!("http-request", "http.url" = %redacted_url(url)).in_scope(|| {
        let mut last_error = None;
        for attempt in 0..3 {
            let mut request = agent()
                .get(url)
                .config()
                .timeout_global(Some(Duration::from_secs(timeout_secs)))
                .build();
            for &(key, value) in headers {
                request = request.header(key, value);
            }
            match request.call().and_then(|mut response| {
                response.body_mut().with_config().limit(limit).read_to_vec()
            }) {
                Ok(bytes) => return Ok(bytes),
                Err(error) => {
                    last_error = Some(error);
                    thread::sleep(Duration::from_secs_f64(0.4 * (attempt + 1) as f64));
                }
            }
        }
        Err(last_error.expect("download attempted").into())
    })
}

pub fn download_to(
    path: &Path,
    url: &str,
    headers: &[(&str, &str)],
    timeout_secs: u64,
) -> anyhow::Result<PathBuf> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    tracing::info_span!("http-request", "http.url" = %redacted_url(url)).in_scope(|| {
        let mut last_error = None;
        for attempt in 0..3 {
            let tmp = temp_path(path, attempt);
            let result = (|| -> anyhow::Result<()> {
                let mut request = agent()
                    .get(url)
                    .config()
                    .timeout_global(Some(Duration::from_secs(timeout_secs)))
                    .build();
                for &(key, value) in headers {
                    request = request.header(key, value);
                }
                let mut response = request.call()?;
                {
                    let mut reader = response
                        .body_mut()
                        .with_config()
                        .limit(DEFAULT_BODY_LIMIT)
                        .reader();
                    let mut file = fs::File::create(&tmp)
                        .with_context(|| format!("creating {}", tmp.display()))?;
                    io::copy(&mut reader, &mut file)
                        .with_context(|| format!("downloading {}", redacted_url(url)))?;
                }
                fs::rename(&tmp, path)
                    .or_else(|_| {
                        fs::remove_file(path).ok();
                        fs::rename(&tmp, path)
                    })
                    .with_context(|| format!("moving {} to {}", tmp.display(), path.display()))?;
                Ok(())
            })();
            match result {
                Ok(()) => return Ok(path.to_path_buf()),
                Err(error) => {
                    fs::remove_file(&tmp).ok();
                    last_error = Some(error);
                    thread::sleep(Duration::from_secs_f64(0.4 * (attempt + 1) as f64));
                }
            }
        }
        Err(last_error.expect("download attempted"))
    })?;
    Ok(path.to_path_buf())
}

pub fn read_or_download(
    path: &Path,
    url: &str,
    headers: &[(&str, &str)],
    timeout_secs: u64,
) -> anyhow::Result<Vec<u8>> {
    if path.exists() {
        return fs::read(path).with_context(|| format!("reading {}", path.display()));
    }
    download_to(path, url, headers, timeout_secs)?;
    fs::read(path).with_context(|| format!("reading {}", path.display()))
}

fn redacted_url(url: &str) -> String {
    match url.split_once('?') {
        Some((base, _)) => format!("{base}?..."),
        None => url.to_string(),
    }
}

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(ureq::Agent::new_with_defaults)
}

fn temp_path(path: &Path, attempt: usize) -> PathBuf {
    let pid = std::process::id();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    path.with_file_name(format!(".{name}.{pid}.{attempt}.tmp"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct ResponseSpec {
        status: &'static str,
        body: Vec<u8>,
        content_type: &'static str,
    }

    fn spawn_server(
        responses: Vec<ResponseSpec>,
    ) -> (String, Arc<Mutex<Vec<String>>>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let pending = Arc::new(Mutex::new(VecDeque::from(responses)));
        let queued = Arc::clone(&pending);
        let handle = std::thread::spawn(move || {
            while let Some(spec) = queued.lock().unwrap().pop_front() {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0u8; 4096];
                let n = stream.read(&mut buffer).unwrap();
                captured
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buffer[..n]).into_owned());
                write!(
                    stream,
                    "HTTP/1.1 {}\r\nContent-Length: {}\r\nContent-Type: {}\r\nConnection: close\r\n\r\n",
                    spec.status,
                    spec.body.len(),
                    spec.content_type
                )
                .unwrap();
                stream.write_all(&spec.body).unwrap();
                stream.flush().unwrap();
            }
        });
        (addr, requests, handle)
    }

    #[test]
    fn download_limited_retries_until_success() {
        let (base, requests, handle) = spawn_server(vec![
            ResponseSpec {
                status: "500 Internal Server Error",
                body: b"nope".to_vec(),
                content_type: "text/plain",
            },
            ResponseSpec {
                status: "503 Service Unavailable",
                body: b"still nope".to_vec(),
                content_type: "text/plain",
            },
            ResponseSpec {
                status: "200 OK",
                body: b"hello".to_vec(),
                content_type: "text/plain",
            },
        ]);
        let bytes = download_limited(
            &format!("{base}/ok?token=secret"),
            &[("X-Test", "yes")],
            1,
            1024,
        )
        .unwrap();
        handle.join().unwrap();
        assert_eq!(bytes, b"hello");
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].starts_with("GET /ok?token=secret HTTP/1.1"));
        assert!(requests[0].to_ascii_lowercase().contains("x-test: yes"));
    }

    #[test]
    fn download_limited_returns_error_after_exhausting_retries() {
        let (base, _, handle) = spawn_server(vec![
            ResponseSpec {
                status: "500 Internal Server Error",
                body: b"1".to_vec(),
                content_type: "text/plain",
            },
            ResponseSpec {
                status: "500 Internal Server Error",
                body: b"2".to_vec(),
                content_type: "text/plain",
            },
            ResponseSpec {
                status: "500 Internal Server Error",
                body: b"3".to_vec(),
                content_type: "text/plain",
            },
        ]);
        let error = download_limited(&format!("{base}/fail"), &[], 1, 8).unwrap_err();
        handle.join().unwrap();
        assert!(format!("{error:#}").contains("500"));
    }

    #[test]
    fn download_to_and_read_or_download_use_disk_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/file.bin");
        let (base, _, handle) = spawn_server(vec![ResponseSpec {
            status: "200 OK",
            body: b"cached".to_vec(),
            content_type: "application/octet-stream",
        }]);
        let written = download_to(&path, &format!("{base}/blob"), &[], 1).unwrap();
        handle.join().unwrap();
        assert_eq!(written, path);
        assert_eq!(fs::read(&path).unwrap(), b"cached");
        assert_eq!(
            read_or_download(&path, "http://127.0.0.1:9/should-not-run", &[], 1).unwrap(),
            b"cached"
        );
    }

    #[test]
    fn download_to_returns_error_after_retries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.bin");
        let (base, _, handle) = spawn_server(vec![
            ResponseSpec {
                status: "500 Internal Server Error",
                body: vec![],
                content_type: "text/plain",
            },
            ResponseSpec {
                status: "500 Internal Server Error",
                body: vec![],
                content_type: "text/plain",
            },
            ResponseSpec {
                status: "500 Internal Server Error",
                body: vec![],
                content_type: "text/plain",
            },
        ]);
        assert!(download_to(&path, &format!("{base}/fail"), &[], 1).is_err());
        handle.join().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn read_or_download_fetches_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fresh.bin");
        let (base, _, handle) = spawn_server(vec![ResponseSpec {
            status: "200 OK",
            body: b"fresh".to_vec(),
            content_type: "application/octet-stream",
        }]);
        let bytes = read_or_download(&path, &format!("{base}/fresh"), &[], 1).unwrap();
        handle.join().unwrap();
        assert_eq!(bytes, b"fresh");
        assert_eq!(fs::read(&path).unwrap(), b"fresh");
    }

    #[test]
    fn redacted_url_and_temp_path_are_stable() {
        assert_eq!(
            redacted_url("https://example.test/a?token=secret"),
            "https://example.test/a?..."
        );
        assert_eq!(
            redacted_url("https://example.test/a"),
            "https://example.test/a"
        );
        let path = Path::new("/tmp/file.bin");
        let tmp = temp_path(path, 2);
        assert_eq!(tmp.parent(), path.parent());
        assert!(
            tmp.file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".file.bin.")
        );
        assert!(
            tmp.file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with(".2.tmp")
        );
    }
}
