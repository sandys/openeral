use crate::error::{Error, Result};
use rustls::pki_types::{pem::PemObject, CertificateDer};
use sha2::{Digest, Sha256};
use std::str::FromStr;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_postgres::config::SslMode;
use tokio_postgres::tls::MakeTlsConnect;
use tokio_postgres::{Client, Config};
use tokio_postgres_rustls::MakeRustlsConnect;
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONNECT_HEADERS: usize = 16 * 1024;
const SUPABASE_POOLER_SUFFIX: &str = ".pooler.supabase.com";
const SUPABASE_ROOT_2021_CA_PATH: &str = "/opt/openrind-shell/certs/supabase-root-2021-ca.pem";

pub struct ConnectedDatabase {
    pub client: Client,
    pub connection_error: tokio::sync::watch::Receiver<Option<String>>,
}

pub async fn connect(database_url: &str) -> Result<ConnectedDatabase> {
    let url = Url::parse(database_url)
        .map_err(|error| Error::Invalid(format!("DATABASE_URL is not a valid URL: {error}")))?;
    if !matches!(url.scheme(), "postgres" | "postgresql") {
        return Err(Error::Invalid(
            "DATABASE_URL must use postgres:// or postgresql://".into(),
        ));
    }
    if url
        .query_pairs()
        .any(|(key, value)| key == "sslmode" && matches!(value.as_ref(), "disable" | "allow"))
    {
        return Err(Error::Invalid(
            "the FUSE runtime forbids disabling PostgreSQL TLS".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| Error::Invalid("DATABASE_URL has no host".into()))?;
    let port = url.port().unwrap_or(5432);

    let proxy_url = proxy_url()?;
    let stream = connect_tunnel(&proxy_url, host, port).await?;

    let mut config = Config::from_str(database_url)
        .map_err(|error| Error::Invalid(format!("invalid PostgreSQL configuration: {error}")))?;
    config.ssl_mode(SslMode::Require);
    config.connect_timeout(CONNECT_TIMEOUT);

    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut tls = tls_connector(host)?;
    let tls = <MakeRustlsConnect as MakeTlsConnect<TcpStream>>::make_tls_connect(&mut tls, host)
        .expect("rustls connector construction is infallible");
    let (client, connection) =
        tokio::time::timeout(CONNECT_TIMEOUT, config.connect_raw(stream, tls))
            .await
            .map_err(|_| Error::Internal("PostgreSQL TLS handshake timed out".into()))??;
    let (error_tx, error_rx) = tokio::sync::watch::channel(None);
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            let _ = error_tx.send(Some(error.to_string()));
        }
    });
    client
        .batch_execute("SET synchronous_commit = on")
        .await
        .map_err(|error| Error::database("configuring PostgreSQL durability", error))?;
    Ok(ConnectedDatabase {
        client,
        connection_error: error_rx,
    })
}

fn tls_connector(host: &str) -> Result<MakeRustlsConnect> {
    // OpenShell's SSL_CERT_FILE is the proxy trust bundle. Preserve those
    // roots, then append the private Supabase database root only for a
    // policy-bound Supabase pooler target.
    let native_roots = rustls_native_certs::load_native_certs();
    let mut roots = rustls::RootCertStore::empty();
    for certificate in native_roots.certs {
        roots.add(certificate).map_err(|error| {
            Error::Internal(format!("could not add a native TLS root: {error}"))
        })?;
    }
    if roots.is_empty() {
        return Err(Error::Internal(
            "could not load any native TLS roots".into(),
        ));
    }
    if !native_roots.errors.is_empty() {
        tracing::warn!(
            errors = native_roots.errors.len(),
            "some native TLS roots could not be loaded"
        );
    }

    if host.to_ascii_lowercase().ends_with(SUPABASE_POOLER_SUFFIX) {
        let pem = std::fs::read(SUPABASE_ROOT_2021_CA_PATH).map_err(|error| {
            Error::Internal(format!(
                "could not read pinned Supabase TLS root at {SUPABASE_ROOT_2021_CA_PATH}: {error}"
            ))
        })?;
        let mut added = 0;
        for certificate in CertificateDer::pem_slice_iter(&pem) {
            roots
                .add(certificate.map_err(|error| {
                    Error::Internal(format!("could not parse pinned Supabase TLS root: {error}"))
                })?)
                .map_err(|error| {
                    Error::Internal(format!("could not add pinned Supabase TLS root: {error}"))
                })?;
            added += 1;
        }
        if added != 1 {
            return Err(Error::Internal(format!(
                "expected exactly one pinned Supabase TLS root, found {added}"
            )));
        }
    }

    Ok(MakeRustlsConnect::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ))
}

fn proxy_url() -> Result<Url> {
    let value = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
        .into_iter()
        .find_map(|key| {
            std::env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| {
            Error::Invalid(
                "OpenShell proxy environment is missing; direct PostgreSQL dialing is forbidden"
                    .into(),
            )
        })?;
    let url = Url::parse(&value)
        .map_err(|error| Error::Invalid(format!("invalid OpenShell proxy URL: {error}")))?;
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        return Err(Error::Invalid(
            "OpenShell PostgreSQL tunneling requires an unauthenticated http:// proxy URL".into(),
        ));
    }
    Ok(url)
}

async fn connect_tunnel(proxy: &Url, target_host: &str, target_port: u16) -> Result<TcpStream> {
    let proxy_host = proxy
        .host_str()
        .ok_or_else(|| Error::Invalid("proxy URL has no host".into()))?;
    let proxy_port = proxy
        .port_or_known_default()
        .ok_or_else(|| Error::Invalid("proxy URL has no port".into()))?;
    let mut stream = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((proxy_host, proxy_port)),
    )
    .await
    .map_err(|_| Error::Internal("OpenShell proxy connection timed out".into()))??;

    let authority = if target_host.contains(':') {
        format!("[{target_host}]:{target_port}")
    } else {
        format!("{target_host}:{target_port}")
    };
    let request = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: Keep-Alive\r\n\r\n"
    );
    tokio::time::timeout(CONNECT_TIMEOUT, stream.write_all(request.as_bytes()))
        .await
        .map_err(|_| Error::Internal("OpenShell CONNECT request timed out".into()))??;

    let mut response = Vec::with_capacity(256);
    let mut byte = [0_u8; 1];
    loop {
        if response.len() >= MAX_CONNECT_HEADERS {
            return Err(Error::Invalid(
                "OpenShell CONNECT response headers exceeded 16 KiB".into(),
            ));
        }
        let read = tokio::time::timeout(CONNECT_TIMEOUT, stream.read(&mut byte))
            .await
            .map_err(|_| Error::Internal("OpenShell CONNECT response timed out".into()))??;
        if read == 0 {
            return Err(Error::Invalid(
                "OpenShell proxy closed before completing CONNECT".into(),
            ));
        }
        response.push(byte[0]);
        if response.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let first_line_end = response
        .windows(2)
        .position(|window| window == b"\r\n")
        .ok_or_else(|| Error::Invalid("malformed OpenShell CONNECT response".into()))?;
    let status_line = std::str::from_utf8(&response[..first_line_end])
        .map_err(|_| Error::Invalid("non-UTF8 OpenShell CONNECT status line".into()))?;
    let status = status_line
        .split_ascii_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| Error::Invalid("malformed OpenShell CONNECT status".into()))?;
    if status != 200 {
        return Err(Error::Internal(format!(
            "OpenShell proxy rejected PostgreSQL CONNECT with status {status}"
        )));
    }
    Ok(stream)
}

#[must_use]
pub fn datasource_hash(database_url: &str) -> String {
    hex::encode(Sha256::digest(
        format!("postgres:{database_url}").as_bytes(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datasource_hash_matches_node_marker_contract() {
        assert_eq!(
            datasource_hash("postgresql://example/test"),
            "be400ba13374bc4bd8e768123fb787d3bf01a166f7737e969e7b64c997c500e8"
        );
    }

    #[test]
    fn proxy_is_mandatory_and_must_be_http() {
        let previous = std::env::var_os("HTTPS_PROXY");
        std::env::set_var("HTTPS_PROXY", "socks5://localhost:1080");
        assert!(proxy_url().is_err());
        match previous {
            Some(value) => std::env::set_var("HTTPS_PROXY", value),
            None => std::env::remove_var("HTTPS_PROXY"),
        }
    }
}
