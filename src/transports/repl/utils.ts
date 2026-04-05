/** Strip ANSI escape sequences and control chars except \n and \t.
 *  Single source of truth — used by renderer (output sanitization)
 *  and key parser (paste sanitization). */
export function sanitize(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r]/g, "");
}
