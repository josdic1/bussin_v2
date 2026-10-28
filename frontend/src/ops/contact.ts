import { formatPhone } from "@bussin/shared";

// Phone and email fields tidy themselves when you leave them, so what's on screen
// is exactly what gets saved: 973-555-0123 and lowercase emails.

/** Formats a phone on blur. Leaves the text alone if it isn't a valid number yet (saving explains why). */
export function tidyPhone(value: string): string {
  const result = formatPhone(value);
  return result.ok ? result.value ?? "" : value;
}

export const tidyEmail = (value: string) => value.trim().toLowerCase();

/** The first problem with a guardian form, in plain words. */
export function contactProblem(issues: { path: PropertyKey[]; message: string }[]): string {
  const issue = issues[0];
  if (issue?.path[0] === "phone") return issue.message;
  if (issue?.path[0] === "email") return "That email doesn't look right. Example: name@example.com";
  return "Enter the guardian's name.";
}
