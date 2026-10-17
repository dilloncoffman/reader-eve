import { defineSchedule } from 'eve/schedules';

export default defineSchedule({
  cron: '0 9 * * *', // 09:00 UTC = 5am EDT (4am EST after clocks go back); Vercel Cron is UTC-only, with no DST handling
  markdown:
    'Run the daily digest for sourceKey dev in mode daily, then run the daily digest for sourceKey learn in mode daily.',
});
