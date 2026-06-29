use std::path::PathBuf;

use ridgeline_baker::{cli_args_to_config, run_with_stdout_progress};

fn main() {
    let trace_guard = ridgeline_baker::trace::init("ridgeline-worker");
    let result = run();
    trace_guard.shutdown();
    if let Err(error) = result {
        eprintln!("Error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let args = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let config = cli_args_to_config(&args)?;
    run_with_stdout_progress(config)
}
