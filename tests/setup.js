process.env.NODE_ENV = 'test';
// Tests that need a database use this replica set (see docker-compose.yml). They skip themselves if it is down.
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/hotel_test?replicaSet=rs0';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-0123';
process.env.OTP_SECRET = 'test-otp-secret-test-otp-secret-0123456';
process.env.BCRYPT_ROUNDS = '4'; // fast hashing in tests only
process.env.PII_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';
