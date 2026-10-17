export type EditionMeta = {
  documentId: string;
  date: string; // 'YYYY-MM-DD'
};

export type EditionChunk = {
  dateRangeLabel: string;
  documentIds: string[];
};

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function parseDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

function formatMonthDay(date: string): string {
  const { month, day } = parseDate(date);
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

function formatFull(date: string): string {
  const { year } = parseDate(date);
  return `${formatMonthDay(date)}, ${year}`;
}

function labelFor(dates: string[]): string {
  const first = dates[0];
  const last = dates[dates.length - 1];
  return first === last ? formatFull(first) : `${formatMonthDay(first)} – ${formatFull(last)}`;
}

export function chunkEditionsByDateRange(editions: EditionMeta[], maxChunks: number): EditionChunk[] {
  if (editions.length === 0) return [];

  const byDate = new Map<string, string[]>();
  for (const edition of editions) {
    const existing = byDate.get(edition.date);
    if (existing) {
      existing.push(edition.documentId);
    } else {
      byDate.set(edition.date, [edition.documentId]);
    }
  }

  const sortedDates = Array.from(byDate.keys()).sort();
  const groupSize = sortedDates.length <= maxChunks ? 1 : Math.ceil(sortedDates.length / maxChunks);

  const chunks: EditionChunk[] = [];
  for (let i = 0; i < sortedDates.length; i += groupSize) {
    const datesInChunk = sortedDates.slice(i, i + groupSize);
    const documentIds = datesInChunk.flatMap((date) => byDate.get(date)!);
    chunks.push({ dateRangeLabel: labelFor(datesInChunk), documentIds });
  }

  return chunks;
}
