-- Scheduling for low-stock phone alerts (production only; the PGlite test harness skips
-- *_schedule.sql because it has no pg_cron). The generator runs on the same 15-minute cadence
-- as expiry alerts. The existing expiry-push job delivers the rows this creates.

select cron.schedule('low-stock-alerts-generate', '*/15 * * * *', 'select private.generate_low_stock_alerts()');
