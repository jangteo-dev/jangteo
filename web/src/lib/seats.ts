import type { Seat } from "../components/Bojagi";
import { paidRound, type Circle } from "./gye";
import type { Dict } from "../i18n/strings";

/** Maps chain state to what each patch of the cloth should show. */
export function seatsOf(c: Circle, t: Dict, you?: string | null): Seat[] {
  const seats: Seat[] = c.members.map((m) => {
    const paidNow = c.phase === "Active" ? paidRound(m, c.round) : c.phase === "Completed" || c.phase === "Filling";
    return {
      state: m.defaulted ? "defaulted" : paidNow ? "paid" : "waiting",
      tookPot: m.received,
      you: !!you && m.address.toLowerCase() === you.toLowerCase(),
      label: m.received ? t.bojagi.tookPot(m.address, m.receivedRound) : m.address,
    };
  });
  while (seats.length < c.size) seats.push({ state: "open" });
  return seats;
}
