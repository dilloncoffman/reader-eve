export interface ParsedEditionTitle {
  date: string; // 'YYYY-MM-DD'
  half: 'AM' | 'PM';
}

export function parseEditionTitle(title: string, listLabel: string): ParsedEditionTitle | null {
  const pattern = new RegExp(`^${listLabel} Twitter List: (.+) (AM|PM) Edition$`);
  const match = title.match(pattern);
  if (!match) return null;

  const [, dateText, half] = match;
  const parsed = new Date(dateText);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');

  return { date: `${year}-${month}-${day}`, half: half as 'AM' | 'PM' };
}
