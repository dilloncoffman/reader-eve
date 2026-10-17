import { describe, it, expect } from 'vitest';
import { parseEditionTitle } from './title-matching';

describe('parseEditionTitle', () => {
  it('parses a matching Dev edition title', () => {
    expect(parseEditionTitle('Dev Twitter List: October 17, 2026 AM Edition', 'Dev')).toEqual({
      date: '2026-10-17',
      half: 'AM',
    });
  });

  it('parses a matching Learn edition title with PM', () => {
    expect(parseEditionTitle('Learn Twitter List: October 16, 2026 PM Edition', 'Learn')).toEqual({
      date: '2026-10-16',
      half: 'PM',
    });
  });

  it('returns null for a title with the wrong list label', () => {
    expect(parseEditionTitle('Learn Twitter List: October 16, 2026 PM Edition', 'Dev')).toBeNull();
  });

  it('returns null for unrelated feed content', () => {
    expect(parseEditionTitle('The race to the bottom feels inevitable…', 'Dev')).toBeNull();
  });
});
