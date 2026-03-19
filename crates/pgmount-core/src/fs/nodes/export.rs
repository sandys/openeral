use crate::error::FsError;
use crate::fs::inode::NodeIdentity;
use crate::fs::nodes::{DirEntry, NodeContext};
use crate::db::queries::{introspection, rows};

const EXPORT_FILES: &[&str] = &["data.json", "data.csv", "data.yaml"];

pub async fn lookup(
    schema: &str,
    table: &str,
    name: &str,
    _ctx: &NodeContext<'_>,
) -> Result<NodeIdentity, FsError> {
    if EXPORT_FILES.contains(&name) {
        let format = name.strip_prefix("data.").unwrap().to_string();
        Ok(NodeIdentity::ExportFile {
            schema: schema.to_string(),
            table: table.to_string(),
            format,
        })
    } else {
        Err(FsError::NotFound)
    }
}

pub async fn readdir(
    schema: &str,
    table: &str,
    _offset: i64,
    _ctx: &NodeContext<'_>,
) -> Result<Vec<DirEntry>, FsError> {
    Ok(EXPORT_FILES.iter().map(|f| {
        let format = f.strip_prefix("data.").unwrap().to_string();
        DirEntry {
            name: f.to_string(),
            identity: NodeIdentity::ExportFile {
                schema: schema.to_string(),
                table: table.to_string(),
                format,
            },
            kind: fuser::FileType::RegularFile,
        }
    }).collect())
}

pub async fn read(
    schema: &str,
    table: &str,
    format: &str,
    offset: i64,
    size: u32,
    ctx: &NodeContext<'_>,
) -> Result<Vec<u8>, FsError> {
    let pk = introspection::get_primary_key(ctx.pool, schema, table).await?;
    if pk.column_names.is_empty() {
        return Err(FsError::DatabaseError("Table has no primary key".to_string()));
    }

    // Fetch all rows (up to page_size limit for safety)
    let row_ids = rows::list_rows(
        ctx.pool, schema, table, &pk.column_names,
        ctx.config.page_size as i64, 0,
    ).await?;

    let mut all_rows = Vec::new();
    for row_id in &row_ids {
        let pk_values: Vec<String> = row_id.pk_values.iter().map(|(_, v)| v.clone()).collect();
        let row_data = rows::get_row_data(ctx.pool, schema, table, &pk.column_names, &pk_values).await?;
        all_rows.push(row_data);
    }

    let content = match format {
        "json" => crate::format::json::format_rows(&all_rows)?,
        "csv" => crate::format::csv::format_rows(&all_rows)?,
        "yaml" => crate::format::yaml::format_rows(&all_rows)?,
        _ => return Err(FsError::InvalidArgument(format!("Unknown format: {}", format))),
    };

    let bytes = content.as_bytes();
    let offset = offset as usize;
    if offset >= bytes.len() {
        return Ok(vec![]);
    }
    let end = (offset + size as usize).min(bytes.len());
    Ok(bytes[offset..end].to_vec())
}
