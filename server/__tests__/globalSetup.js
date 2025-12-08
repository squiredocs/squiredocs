// Jest global setup - runs once before all test suites
const path = require('path');
const { execSync } = require('child_process');

module.exports = async () => {
  // Run database migrations before all tests
  console.log('\n🔄 Running database migrations...');
  try {
    execSync('npm run migrate', {
      cwd: path.join(__dirname, '../..'),
      stdio: 'pipe',
      env: { ...process.env }
    });
    console.log('✅ Migrations complete.\n');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error; // Fail the test run if migrations fail
  }
};
