use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    // Detect mount.fuse3 invocation: argv[2] is /dev/fd/N
    let result = if openrind_shell_core::cli::is_fuse_fd_invocation() {
        openrind_shell_core::cli::fuse_fd::execute().await
    } else {
        openrind_shell_core::cli::run().await
    };

    if let Err(e) = result {
        tracing::error!("Fatal error: {e}");
        std::process::exit(1);
    }
}
