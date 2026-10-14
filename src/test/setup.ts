import 'fake-indexeddb/auto';

// Run every test in South African time so UTC-vs-local date bugs show up.
process.env.TZ = 'Africa/Johannesburg';
