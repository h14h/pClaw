/**
 * "Fri 2026-10-02 09:41 (America/Los_Angeles, UTC-07:00)". Goes at the top of every message the model sees, so it
 * knows when things were said and can turn "tomorrow at 9" into an exact time.
 */
export function stamp(at: number, timeZone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			weekday: "short",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(at)
			.map((part) => [part.type, part.value]),
	);
	return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${timeZone}, ${utcOffset(at, timeZone)})`;
}

/** "UTC-07:00" for the zone's offset at `at`. */
export function utcOffset(at: number, timeZone: string): string {
	const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
		.formatToParts(at)
		.find((part) => part.type === "timeZoneName")?.value;
	// Intl writes "GMT-07:00", or plain "GMT" for UTC itself.
	if (name === undefined || name === "GMT") return "UTC+00:00";
	return name.replace("GMT", "UTC");
}
