import path from "node:path";

function sourceExtension(filename) {
  return path.extname(String(filename ?? "").trim());
}

export function downloadDialogFilters(filename) {
  const extension = sourceExtension(filename).slice(1);
  if (!/^[A-Za-z0-9][A-Za-z0-9+_-]{0,31}$/.test(extension)) {
    return undefined;
  }
  return [
    {
      name: `${extension.toUpperCase()} file`,
      extensions: [extension],
    },
  ];
}

export function preserveDownloadExtension(destination, sourceFilename) {
  const requestedDestination = String(destination ?? "").trim();
  const extension = sourceExtension(sourceFilename);
  if (!requestedDestination || !extension) return requestedDestination;

  const selectedExtension = path.extname(requestedDestination);
  if (selectedExtension && selectedExtension !== ".") {
    return requestedDestination;
  }
  return `${requestedDestination.replace(/\.+$/, "")}${extension}`;
}
