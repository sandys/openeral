pub mod introspection;
pub mod rows;
pub mod indexes;
pub mod stats;

/// Wraps an identifier in double quotes, escaping any internal double quotes by doubling them.
pub fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
