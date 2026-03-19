use crate::error::FsError;
use crate::fs::inode::{NodeIdentity, OrderStage};
use crate::fs::nodes::{DirEntry, NodeContext};
use crate::db::queries::introspection;
use crate::db::types::PrimaryKeyInfo;

/// Lookup child of .order/ root -> column names
pub async fn lookup_root(
    schema: &str,
    table: &str,
    name: &str,
    ctx: &NodeContext<'_>,
) -> Result<NodeIdentity, FsError> {
    let columns = introspection::list_columns(ctx.pool, schema, table).await?;
    if columns.iter().any(|c| c.name == name) {
        Ok(NodeIdentity::OrderDir {
            schema: schema.to_string(),
            table: table.to_string(),
            stage: OrderStage::Column { column: name.to_string() },
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
        identity: NodeIdentity::OrderDir {
            schema: schema.to_string(),
            table: table.to_string(),
            stage: OrderStage::Column { column: c.name.clone() },
        },
        kind: fuser::FileType::Directory,
    }).collect())
}

/// Lookup child of .order/<col>/ -> "asc" or "desc"
pub async fn lookup_column(
    schema: &str,
    table: &str,
    column: &str,
    name: &str,
    _ctx: &NodeContext<'_>,
) -> Result<NodeIdentity, FsError> {
    match name {
        "asc" | "desc" => Ok(NodeIdentity::OrderDir {
            schema: schema.to_string(),
            table: table.to_string(),
            stage: OrderStage::Direction {
                column: column.to_string(),
                dir: name.to_string(),
            },
        }),
        _ => Err(FsError::NotFound),
    }
}

pub async fn readdir_column(
    schema: &str,
    table: &str,
    column: &str,
    _offset: i64,
    _ctx: &NodeContext<'_>,
) -> Result<Vec<DirEntry>, FsError> {
    Ok(["asc", "desc"].iter().map(|dir| DirEntry {
        name: dir.to_string(),
        identity: NodeIdentity::OrderDir {
            schema: schema.to_string(),
            table: table.to_string(),
            stage: OrderStage::Direction {
                column: column.to_string(),
                dir: dir.to_string(),
            },
        },
        kind: fuser::FileType::Directory,
    }).collect())
}

/// Lookup in .order/<col>/asc|desc/ -> row directories
pub async fn lookup_direction(
    schema: &str,
    table: &str,
    _column: &str,
    _dir: &str,
    name: &str,
    _ctx: &NodeContext<'_>,
) -> Result<NodeIdentity, FsError> {
    Ok(NodeIdentity::Row {
        schema: schema.to_string(),
        table: table.to_string(),
        pk_display: name.to_string(),
    })
}

/// readdir for .order/<col>/asc|desc/ -> list rows in that order
pub async fn readdir_direction(
    schema: &str,
    table: &str,
    column: &str,
    dir: &str,
    _offset: i64,
    ctx: &NodeContext<'_>,
) -> Result<Vec<DirEntry>, FsError> {
    let pk = get_pk(schema, table, ctx).await?;
    if pk.column_names.is_empty() {
        return Ok(vec![]);
    }

    let ordered = query_ordered_rows(ctx.pool, schema, table, column, dir, &pk.column_names, ctx.config.page_size as i64).await?;

    Ok(ordered.iter().map(|row_id| DirEntry {
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

async fn query_ordered_rows(
    pool: &deadpool_postgres::Pool,
    schema: &str,
    table: &str,
    order_column: &str,
    direction: &str,
    pk_columns: &[String],
    limit: i64,
) -> Result<Vec<crate::db::types::RowIdentifier>, FsError> {
    let client = pool.get().await
        .map_err(|e| FsError::DatabaseError(format!("Failed to get connection: {}", e)))?;

    let select_cols: Vec<String> = pk_columns.iter()
        .map(|c| crate::db::queries::quote_ident(c))
        .collect();

    let dir_sql = if direction == "desc" { "DESC" } else { "ASC" };

    let query = format!(
        "SELECT {} FROM {}.{} ORDER BY {} {} LIMIT $1",
        select_cols.join(", "),
        crate::db::queries::quote_ident(schema),
        crate::db::queries::quote_ident(table),
        crate::db::queries::quote_ident(order_column),
        dir_sql,
    );

    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = vec![&limit];
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
