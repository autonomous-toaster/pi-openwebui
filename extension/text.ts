/**
 * Token-aware text helpers: Open WebUI documents are routinely far larger than a
 * sensible tool result (notes here are 60–80k characters), so reads are sliced and
 * the model is told how to continue.
 */

export interface Clip {
	text: string;
	offset: number;
	nextOffset?: number;
	total: number;
}

export function clip(text: string, offset: number, limit: number): Clip {
	const total = text.length;
	const start = Math.min(Math.max(0, Math.trunc(offset)), total);
	const end = Math.min(start + Math.max(1, Math.trunc(limit)), total);
	const result: Clip = { text: text.slice(start, end), offset: start, total };
	if (end < total) result.nextOffset = end;
	return result;
}

/** Appends a one-line continuation hint when the slice is not the whole document. */
export function withHint(clipped: Clip, noun: string): string {
	if (clipped.nextOffset === undefined) return clipped.text;
	return `${clipped.text}\n\n…[${noun}: ${clipped.offset}-${clipped.nextOffset} of ${clipped.total} chars — continue with offset=${clipped.nextOffset}]`;
}

export function oneLine(value: unknown, max = 140): string {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function timestamp(epochValue: number | undefined): string {
	if (!epochValue) return "unknown";
	// Open WebUI mixes second, millisecond and nanosecond epochs.
	const ms =
		epochValue > 1e17 ? epochValue / 1e6 : epochValue > 1e14 ? epochValue / 1e3 : epochValue > 1e12 ? epochValue : epochValue * 1000;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
}
