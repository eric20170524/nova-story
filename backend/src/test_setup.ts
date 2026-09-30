// Import before application modules in database-backed tests, including direct runs.
process.env.DATABASE_URL = ':memory:';
