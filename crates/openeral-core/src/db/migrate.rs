use std::ops::DerefMut;

use crate::error::FsError;
use tracing::info;

const MIGRATION_LOCK_KEY_1: i32 = 0x6f70656e; // "open"
const MIGRATION_LOCK_KEY_2: i32 = 0x6572616c; // "eral"

mod embedded {
    use refinery::embed_migrations;
    embed_migrations!("migrations");
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationOutcome {
    applied_count: usize,
}

impl MigrationOutcome {
    pub fn new(applied_count: usize) -> Self {
        Self { applied_count }
    }

    pub fn applied_count(&self) -> usize {
        self.applied_count
    }

    pub fn was_noop(&self) -> bool {
        self.applied_count == 0
    }
}

async fn acquire_migration_lock(client: &tokio_postgres::Client) -> Result<(), FsError> {
    info!("Waiting for migration lock");
    client
        .query_one(
            "SELECT pg_advisory_lock($1, $2)",
            &[&MIGRATION_LOCK_KEY_1, &MIGRATION_LOCK_KEY_2],
        )
        .await
        .map_err(|e| FsError::DatabaseError(format!("Failed to acquire migration lock: {}", e)))?;
    info!("Migration lock acquired");
    Ok(())
}

async fn release_migration_lock(client: &tokio_postgres::Client) -> Result<(), FsError> {
    let released = client
        .query_one(
            "SELECT pg_advisory_unlock($1, $2)",
            &[&MIGRATION_LOCK_KEY_1, &MIGRATION_LOCK_KEY_2],
        )
        .await
        .map_err(|e| FsError::DatabaseError(format!("Failed to release migration lock: {}", e)))?
        .get::<_, bool>(0);

    if released {
        Ok(())
    } else {
        Err(FsError::InternalError(
            "Migration lock was not held by this session".to_string(),
        ))
    }
}

/// Run all pending database migrations.
///
/// Creates the `_openeral` schema and internal metadata tables.
/// Safe to call multiple times — already-applied migrations are skipped.
pub async fn run_migrations(pool: &deadpool_postgres::Pool) -> Result<MigrationOutcome, FsError> {
    let mut client = pool.get().await.map_err(|e| {
        FsError::DatabaseError(format!("Failed to get connection for migrations: {}", e))
    })?;

    acquire_migration_lock(&client).await?;

    let report_result = {
        let client_ref: &mut tokio_postgres::Client = client.deref_mut();
        info!("Running database migrations");
        embedded::migrations::runner().run_async(client_ref).await
    };
    let unlock_result = release_migration_lock(&client).await;

    let report =
        report_result.map_err(|e| FsError::DatabaseError(format!("Migration failed: {}", e)))?;
    unlock_result?;

    let outcome = MigrationOutcome::new(report.applied_migrations().len());
    info!(
        applied_count = outcome.applied_count(),
        "Migrations complete"
    );
    Ok(outcome)
}

/// Record a mount session in the `_openeral.mount_log` table.
pub async fn log_mount_session(
    pool: &deadpool_postgres::Pool,
    mount_point: &str,
    schemas_filter: Option<&[String]>,
    page_size: usize,
) -> Result<(), FsError> {
    let client = pool.get().await.map_err(|e| {
        FsError::DatabaseError(format!("Failed to get connection for mount log: {}", e))
    })?;

    let version = env!("CARGO_PKG_VERSION");
    let schemas: Option<Vec<&str>> = schemas_filter.map(|s| s.iter().map(|s| s.as_str()).collect());

    client
        .execute(
            "INSERT INTO _openeral.mount_log (mount_point, schemas_filter, page_size, openeral_version) \
             VALUES ($1, $2, $3, $4)",
            &[&mount_point, &schemas, &(page_size as i32), &version],
        )
        .await
        .map_err(|e| FsError::DatabaseError(format!("Failed to log mount session: {}", e)))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::pool::create_pool;
    use std::time::Duration;

    fn connection_string() -> String {
        std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| {
            "host=postgres user=pgmount password=pgmount dbname=testdb".to_string()
        })
    }

    async fn get_pool() -> deadpool_postgres::Pool {
        create_pool(&connection_string(), 30).unwrap()
    }

    #[tokio::test]
    async fn test_run_migrations_noop_on_second_run() {
        let pool = get_pool().await;

        let _first = run_migrations(&pool).await.unwrap();
        let second = run_migrations(&pool).await.unwrap();

        assert!(second.was_noop());
    }

    #[tokio::test]
    async fn test_migration_lock_blocks_second_runner() {
        let pool = get_pool().await;
        run_migrations(&pool).await.unwrap();

        let lock_holder = pool.get().await.unwrap();
        acquire_migration_lock(&lock_holder).await.unwrap();

        let waiting_pool = pool.clone();
        let wait_task = tokio::spawn(async move { run_migrations(&waiting_pool).await.unwrap() });

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !wait_task.is_finished(),
            "second migration runner should block on advisory lock"
        );

        release_migration_lock(&lock_holder).await.unwrap();

        let outcome = wait_task.await.unwrap();
        assert!(outcome.was_noop());
    }
}
