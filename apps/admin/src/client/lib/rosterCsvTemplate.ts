export const ROSTER_CSV_TEMPLATE =
  "email,name,role\r\nalovelace@uw.edu,Ada Lovelace,student\r\nghopper@uw.edu,Grace Hopper,ta\r\n";

export const ROSTER_CSV_TEMPLATE_FILENAME = "llteacher-roster-template.csv";

export function downloadRosterCsvTemplate() {
  const url = URL.createObjectURL(new Blob([ROSTER_CSV_TEMPLATE], { type: "text/csv" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = ROSTER_CSV_TEMPLATE_FILENAME;
  anchor.click();
  URL.revokeObjectURL(url);
}
