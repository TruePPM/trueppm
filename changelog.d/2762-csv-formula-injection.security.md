- **CSV formula-injection (CSV/DDE) hardening on export**: task CSV export
  (`exportTasksToCsv`) and risk-register CSV export (`exportRisksToCSV`) now
  neutralize a leading `=`, `+`, `-`, `@`, tab, or carriage-return character by
  prefixing the cell with a leading `'` before applying RFC 4180 quoting. This
  closes a stored formula-injection path where a task name imported from CSV
  (which applies no character filtering on ingest) could execute as a formula
  or command in a teammate's spreadsheet application when the schedule or
  risk register was exported and opened in Excel, Google Sheets, or
  LibreOffice.
