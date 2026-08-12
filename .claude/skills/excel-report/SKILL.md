---
name: excel-report
description: Create a comprehensive Markdown report summarizing one or more uploaded Microsoft Excel .xlsx workbooks in the Openrind Shell sandbox. Automatically invoked when the user asks to summarize, analyze, or create a report for Excel files.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Glob
argument-hint: [path to .xlsx file]
---

# Excel reporting

YOU are responsible for creating a useful, auditable Markdown report from one or more uploaded `.xlsx` workbooks. Uploaded files are typically available in `/home/agent/inbox` or `/sandbox`.

**CRITICAL INSTRUCTION FOR CLAUDE**: Skills do NOT run automatically in the background. When you load this skill, YOU (Claude) must manually perform the steps below using your available tools. Do not sit and wait for the report to generate itself. YOU must write the report.

## Your Workflow

1. **Locate the files**: Inspect `/home/agent/inbox` and `/sandbox` to find the `.xlsx` files provided by the user.

2. **Read the workbooks**: You CANNOT read Excel files using `cat` or any default tools. You MUST write and execute a Python script to do it.
   - **YOU must use your `Bash` tool to run the following exact block of commands**:

```bash
uv venv /tmp/venv
uv pip install --python /tmp/venv openpyxl pandas tabulate

cat << 'EOF' > /tmp/analyze_excel.py
import sys
import pandas as pd

def analyze_file(file_path):
    print(f"Analyzing {file_path}...\n")
    try:
        df_dict = pd.read_excel(file_path, sheet_name=None)
        for name, df in df_dict.items():
            print(f"=== Worksheet: {name} ===")
            print(f"Rows: {df.shape[0]}, Columns: {df.shape[1]}\n")
            print("--- Columns and Data Types ---")
            for col in df.columns:
                print(f"- {col}: {df[col].dtype}")
            print("\n--- Summary Statistics ---")
            print(df.describe(include='all').to_markdown())
            print("\n--- First 10 Rows (Sample Data) ---")
            print(df.head(10).to_markdown())
            print("\n" + "="*50 + "\n")
    except Exception as e:
        print(f"Error reading file: {e}")

if __name__ == "__main__":
    for path in sys.argv[1:]:
        analyze_file(path)
EOF
```

3. **Execute the Script**: Now use your `Bash` tool to run the script on the specific files the user asked you to analyze (or the `.xlsx` files you found). Use the absolute path to the Python executable.

```bash
/tmp/venv/bin/python /tmp/analyze_excel.py "<absolute_path_to_uploaded_file_1>" "<absolute_path_to_uploaded_file_2>"
```

4. **Interpret the data**: Once YOU have executed the bash script from step 3, you will receive its output in your terminal. Use that output (which contains row counts, schemas, summary statistics, and sample data) to identify trends, missing values, top categories, or key performance metrics.

5. **Write the report**: Use your `Bash` or `Write` tool to create a comprehensive Markdown report summarizing the files. Save the result as `/home/agent/inbox/analysis-report.md`.

## Report format

Use this Markdown structure for your report:

1. **Executive Summary** — concise, factual overview of the data and most important high-level findings across all uploaded files.
2. **Data Scope** — files analyzed, row/column counts, date ranges, and notes on missing values or duplicates.
3. **Key Metrics & Statistics** — a compact Markdown table highlighting core numbers, totals, or averages identified in the summary stats.
4. **Detailed Findings** — specific trends, outliers, or distributions tied to named worksheet columns.
5. **Next Steps** — list any open questions or anomalies in the data that the user might want to investigate further.

After saving the Markdown file, tell the user its exact path (`/home/agent/inbox/...`) and output the full report directly in the chat so they can read it immediately.
