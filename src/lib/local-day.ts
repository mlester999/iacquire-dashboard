// Today's date (YYYY-MM-DD) as the person's own clock shows it, for the starting value of a date field. `new Date().toISOString().slice(0, 10)` is the UTC date, which is still
// yesterday for the first hours of a day anywhere east of UTC (in Manila, from midnight to 8 a.m.), so a form that opened with it started on the wrong day. Use this in a browser
// (an event handler, a dialog's own state); a value that decides how a server-rendered page looks must not depend on it, because the server's clock and the visitor's can differ.
export function localDayIso(now: Date = new Date(), addDays = 0): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + addDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
