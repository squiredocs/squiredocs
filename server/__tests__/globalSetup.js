// Jest global setup - runs once before all test suites
const path = require('path');
const { execSync } = require('child_process');
const { Pool } = require('pg');
const { getTestDatabaseUrl, TEST_DB_NAME } = require('./helpers/db');

module.exports = async () => {
  const testDbUrl = getTestDatabaseUrl();

  // Ensure the test database exists (connect to default 'postgres' db to create it)
  const adminUrl = testDbUrl.replace(/\/[^/?]+([?#].*)?$/, '/postgres$1');
  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    const result = await adminPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB_NAME]
    );
    if (result.rows.length === 0) {
      console.log(`\n📦 Creating ${TEST_DB_NAME}...`);
      await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
      console.log('✅ Test database created.');
    }
  } catch (error) {
    if (error.code !== '42P04') { // 42P04 = database already exists
      console.error('❌ Could not create test database:', error.message);
      throw error;
    }
  } finally {
    await adminPool.end();
  }

  // Run database migrations against the test database
  console.log('\n🔄 Running database migrations...');
  try {
    execSync('npm run migrate', {
      cwd: path.join(__dirname, '../..'),
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: testDbUrl }
    });
    console.log('✅ Migrations complete.\n');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  }
};
