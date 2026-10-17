import { defineSchedule } from 'eve/schedules';

export default defineSchedule({
  cron: '0 9 * * *', // 5am America/New_York (EST); Vercel Cron is UTC-only — confirm timezone before deploy
  markdown:
    'Run the daily digest for sourceKey dev in mode daily, then run the daily digest for sourceKey learn in mode daily.',
});
