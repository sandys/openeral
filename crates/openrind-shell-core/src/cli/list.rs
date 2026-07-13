use crate::error::FsError;

pub async fn execute() -> Result<(), FsError> {
    // Read /proc/mounts or /etc/mtab to find openrind-shell entries
    let mounts = std::fs::read_to_string("/proc/mounts").map_err(FsError::IoError)?;

    let mut found = false;
    for line in mounts.lines() {
        if line.contains("openrind-shell") || line.contains("fuse.openrind-shell") {
            println!("{}", line);
            found = true;
        }
    }

    if !found {
        println!("No active openrind-shell mounts found.");
    }

    Ok(())
}
