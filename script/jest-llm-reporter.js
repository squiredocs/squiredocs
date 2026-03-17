const path = require('path');

const STACK_RE = /^\s+at\s.+[:(](\d+):\d+/;

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

    const parts = [`Server: ${numTotalTestSuites} suites`];
    if (numPassedTests > 0) parts.push(`${numPassedTests} passed`);
    if (numPendingTests > 0) parts.push(`${numPendingTests} skipped`);
    if (numFailedTests > 0) parts.push(`${numFailedTests} FAILED`);
    console.log(`${parts.join(', ')} (${duration}s)`);

    if (numFailedTests > 0) {
      console.log('\nFAILED:\n');
      let failIndex = 0;
      for (const suite of testResults) {
        for (const test of suite.testResults || []) {
          if (test.status !== 'failed') continue;
          failIndex++;
          const relPath = path.relative(process.cwd(), suite.testFilePath || '');
          const testName = [...(test.ancestorTitles || []), test.title].join(' > ');
          console.log(`${failIndex}) ${relPath} > ${testName}`);

          if (test.failureMessages && test.failureMessages.length > 0) {
            const lines = test.failureMessages[0].split('\n');
            let lineNum = null;
            let printed = 0;
            for (const line of lines) {
              const atMatch = line.match(STACK_RE);
              if (atMatch) {
                if (!lineNum) lineNum = atMatch[1];
                break;
              }
              if (printed < 10 && line.trim()) {
                console.log(`   ${line.trim()}`);
                printed++;
              }
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
