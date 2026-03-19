use crate::error::FsError;
use crate::fs::inode::{NodeIdentity, FilterStage};
use crate::fs::nodes::{DirEntry, NodeContext};
use crate::db::queries::introspection;
use crate::db::types::PrimaryKeyInfo;

/// Lookup child of .filter/ root -> column names
pub async fn lookup_root(
    schema: &str,
    table: &str,
    name: &str,
    ctx: &NodeContext<'_>,
) -> Result<NodeIdentity, FsError> {
    let columns = introspection::list_columns(ctx.pool, schema, table).await?;
    if columns.iter().any(|c| c.name == name) {
        Ok(NodeIdentity::FilterDir {
            schema: schema.to_string(),
            table: table.to_string(),
            stage: FilterStage::Column { column: name.to_string() },
        })
    } else {
        Err(FsError::NotFound)
    }
}

pub async fn readdir_root(
    schema: &str,
    table: &str,
    _offset: i64,
    ctx: &NodeContext<'_>,
) -> Result<Vec<DirEntry>, FsError> {
    let columns = introspection::list_columns(ctx.pool, schema, table).await?;
    Ok(columns.iter().map(|c| DirEntry {
        name: c.name.clone(),
        identity: NodeIdentity::FilterDir {
            schema: schema.to_string(),
            table: table.to_string(),
            stage: FilterStage::Column { column: c.name.clone() },
        },
        kind: fuser::FileType::Directory,
    }).collect())
}

/// Lookup child of .filter/<col>/ -> any value is accepted as a filter value
pub async fn lookup_column(
    schema: &str,
    table: &str,
    column: &str,
    value: &str,
    _ctx: &NodeContext<'_>,
) -> Result<NodeIdentity, FsError> {
    Ok(NodeIdentity::FilterDir {
        schema: schema.to_string(),
        table: table.to_string(),
        stage: FilterStage::Value {
            column: column.to_string(),
            value: value.to_string(),
        },
    })
}

/// readdir for .filter/<col>/ -- we can't enumerate all possible values,
/// so return an empty listing. Users navigate via lookup (ls specific value).
pub async fn readdir_column(
    _schema: &str,
    _table: &str,
    _column: &str,
    _offset: i64,
    _ctx: &NodeContext<'_>,
) -> Result<Vec<DirEntry>, FsError> {
    // Can't enumerate values -- user must access by name
    Ok(vec![])
}

/// Lookup child of .filter/<col>/<value>/ -> shows filtered rows
/// Children are: row directories (matching the filter) + the usual special dirs
pub async fn lookup_value(
    schema: &str,
    table: &str,
    _column: &str,
    _value: &str,
    name: &str,
    ctx: &NodeContext<'_>,
) -> Result<NodeIdentity, FsError> {
    // The filtered result dir acts like a table dir -- rows + special dirs are children.
    // For simplicity, rows in a filter result are still NodeIdentity::Row.
    let pk = get_pk(schema, table, ctx).await?;
    if pk.column_names.is_empty() {
        return Err(FsError::NotFound);
    }
    // Treat the child as a row pk_display
    Ok(NodeIdentity::Row {
        schema: schema.to_string(),
        table: table.to_string(),
        pk_display: name.to_string(),
    })
}

/// readdir for .filter/<col>/<value>/ -> list matching rows
pub async fn readdir_value(
    schema: &str,
    table: &str,
    column: &str,
    value: &str,
    _offset: i64,
    ctx: &NodeContext<'_>,
) -> Result<Vec<DirEntry>, FsError> {
    let pk = get_pk(schema, table, ctx).await?;
    if pk.column_names.is_empty() {
        return Ok(vec![]);
    }

    // Query filtered rows
    let filtered = query_filtered_rows(ctx.pool, schema, table, column, value, &pk.column_names, ctx.config.page_size as i64).await?;

    Ok(filtered.iter().map(|row_id| DirEntry {
        name: row_id.display_name.clone(),
        identity: NodeIdentity::Row {
            schema: schema.to_string(),
            table: table.to_string(),
            pk_display: row_id.display_name.clone(),
        },
        kind: fuser::FileType::Directory,
    }).collect())
}

async fn get_pk(schema: &str, table: &str, ctx: &NodeContext<'_>) -> Result<PrimaryKeyInfo, FsError> {
    if let Some(cached) = ctx.cache.get_primary_key(schema, table) {
        return Ok(cached);
    }
    let pk = introspection::get_primary_key(ctx.pool, schema, table).await?;
    ctx.cache.set_primary_key(schema, table, pk.clone());
    Ok(pk)
}

/// Execute a filtered query and return matching row identifiers
async fn query_filtered_rows(
    pool: &deadpool_postgres::Pool,
    schema: &str,
    table: &str,
    filter_column: &str,
    filter_value: &str,
    pk_columns: &[String],
    limit: i64,
) -> Result<Vec<crate::db::types::RowIdentifier>, FsError> {
    let client = pool.get().await
        .map_err(|e| FsError::DatabaseError(format!("Failed to get connection: {}", e)))?;

    let select_cols: Vec<String> = pk_columns.iter()
        .map(|c| crate::db::queries::quote_ident(c))
        .collect();
    let order_cols = select_cols.clone();

    let query = format!(
        "SELECT {} FROM {}.{} WHERE {}::text = $1 ORDER BY {} LIMIT $2",
        select_cols.join(", "),
        crate::db::queries::quote_ident(schema),
        crate::db::queries::quote_ident(table),
        crate::db::queries::quote_ident(filter_column),
        order_cols.join(", "),
    );

    let limit_param = limit;
    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = vec![
        &filter_value as &(dyn tokio_postgres::types::ToSql + Sync),
        &limit_param,
    ];

    let rows = client.query(&query, &params).await?;

    let mut result = Vec::new();
    for row in &rows {
        let mut pk_values = Vec::new();
        let mut display_parts = Vec::new();
        for (i, col_name) in pk_columns.iter().enumerate() {
            let value_str: String = row.try_get::<_, String>(i)
                .or_else(|_| row.try_get::<_, i32>(i).map(|v| v.to_string()))
                .or_else(|_| row.try_get::<_, i64>(i).map(|v| v.to_string()))
                .unwrap_or_else(|_| "NULL".to_string());
            if pk_columns.len() == 1 {
                display_parts.push(value_str.clone());
            } else {
                display_parts.push(format!("{}={}", col_name, &value_str));
            }
            pk_values.push((col_name.clone(), value_str));
        }
        result.push(crate::db::types::RowIdentifier {
            pk_values,
            display_name: display_parts.join(","),
        });
    }

    Ok(result)
}
