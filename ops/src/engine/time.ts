/** Korea time for anything a person reads (Telegram). Server logs stay in UTC. */
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "09-23 14:05 KST" */
export function kst(ms: number): string {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute} KST`;
}
