const path = require('path');

class LlmReporter {
  onRunComplete(_testContexts, results) {
    const {
      numTotalTestSuites,
      numPassedTests,
      numFailedTests,
      numPendingTests,
      startTime,
      testResults,
    } = results;

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Build summary line
    const parts = [`Server: ${numTotalTestSuites} suites`];
    if (numPassedTests > 0) parts.push(`${numPassedTests} passed`);
    if (numPendingTests > 0) parts.push(`${numPendingTests} skipped`);
    if (numFailedTests > 0) parts.push(`${numFailedTests} FAILED`);
    parts.push(`(${duration}s)`);
    console.log(parts.join(', '));

    // Print failure details
    if (numFailedTests > 0) {
      console.log('\nFAILED:\n');
      let failIndex = 0;
      for (const suite of testResults) {
        for (const test of suite.testResults || []) {
          if (test.status !== 'failed') continue;
          failIndex++;
          const relPath = path.relative(process.cwd(), suite.testFilePath || suite.name || '');
          const testName = [...(test.ancestorTitles || []), test.title].join(' > ');
          console.log(`${failIndex}) ${relPath} > ${testName}`);

          // Extract assertion message (lines before stack trace)
          if (test.failureMessages && test.failureMessages.length > 0) {
            const lines = test.failureMessages[0].split('\n');
            const msgLines = [];
            let lineNum = null;
            for (const line of lines) {
              const atMatch = line.match(/^\s+at\s.+[:(](\d+):\d+/);
              if (atMatch) {
                if (!lineNum) lineNum = atMatch[1];
                break;
              }
              if (msgLines.length < 10) msgLines.push(line);
            }
            for (const ml of msgLines) {
              if (ml.trim()) console.log(`   ${ml.trim()}`);
            }
            if (lineNum) console.log(`   (line ${lineNum})`);
          }
          console.log('');
        }
      }
    }
  }
}

module.exports = LlmReporter;
