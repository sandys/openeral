import assert from "node:assert/strict";
import test from "node:test";

import {
  downloadDialogFilters,
  preserveDownloadExtension,
} from "../../electron/openshell/download-destination.mjs";

test("download dialog exposes the artifact's original file type", () => {
  assert.deepEqual(downloadDialogFilters("analysis-report.md"), [
    { name: "MD file", extensions: ["md"] },
  ]);
  assert.deepEqual(downloadDialogFilters("Sales_Transactions.xlsx"), [
    { name: "XLSX file", extensions: ["xlsx"] },
  ]);
  assert.equal(downloadDialogFilters("README"), undefined);
});

test("download destination restores a missing artifact extension", () => {
  assert.equal(
    preserveDownloadExtension("C:\\Downloads\\analysis-report", "analysis-report.md"),
    "C:\\Downloads\\analysis-report.md",
  );
  assert.equal(
    preserveDownloadExtension("C:\\Downloads\\sales", "Sales_Transactions.xlsx"),
    "C:\\Downloads\\sales.xlsx",
  );
  assert.equal(
    preserveDownloadExtension("C:\\Downloads\\analysis-report.md", "analysis-report.md"),
    "C:\\Downloads\\analysis-report.md",
  );
  assert.equal(
    preserveDownloadExtension("C:\\Downloads\\analysis-report.", "analysis-report.md"),
    "C:\\Downloads\\analysis-report.md",
  );
});
