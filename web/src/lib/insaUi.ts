import type { Dict } from "../i18n/strings";

/** A creator's phase name, in the reader's language when it is one of the usual three. */
export function phaseLabel(s: Dict["ins"], name: string | undefined, i: number): string {
  const n = (name ?? "").trim().toLowerCase();
  if (n === "guaranteed" || n === "gtd") return s.gtdPhase;
  if (n === "allowlist" || n === "whitelist" || n === "wl") return s.listPhase;
  if (n === "public") return s.publicPhase;
  return name?.trim() || s.phaseN(i + 1);
}
