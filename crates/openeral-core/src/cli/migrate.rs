use clap::Args;

use crate::config::connection::resolve_connection_string;
use crate::db::migrate;
use crate::db::pool::create_pool;
use crate::error::FsError;

#[derive(Args)]
pub struct MigrateArgs {
    /// PostgreSQL connection string
    #[arg(short, long)]
    pub connection: Option<String>,

    /// Statement timeout in seconds
    #[arg(long, default_value = "30")]
    pub statement_timeout: u64,
}

pub async fn execute(args: MigrateArgs) -> Result<(), FsError> {
    let conn_str = resolve_connection_string(args.connection.as_deref(), "OPENERAL_DATABASE_URL")?;
    let pool = create_pool(&conn_str, args.statement_timeout)?;

    let outcome = migrate::run_migrations(&pool).await?;
    if outcome.was_noop() {
        println!("Database migrations are up to date");
    } else {
        println!("Applied {} database migration(s)", outcome.applied_count());
    }

    Ok(())
}
