import path from 'path';

function collectTests(tasks, results = []) {
  for (const task of tasks) {
    if (task.type === 'suite' && task.tasks) {
      collectTests(task.tasks, results);
    } else {
      results.push(task);
    }
  }
  return results;
}

function getTestPath(task) {
  const parts = [];
  let current = task.suite;
  while (current && current.name) {
    parts.unshift(current.name);
    current = current.suite;
  }
  parts.push(task.name);
  return parts.join(' > ');
}

export default class LlmReporter {
  onUserConsoleLog() {
    // suppress console output from tests
  }

  onFinished(files = []) {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const failures = [];

    for (const file of files) {
      const tests = collectTests(file.tasks);
      for (const test of tests) {
        const state = test.result?.state;
        if (state === 'pass') passed++;
        else if (state === 'fail') {
          failed++;
          failures.push({ file: file.filepath, test });
        }
        else skipped++;
      }
    }

    // Compute duration from file results
    let totalDuration = 0;
    for (const file of files) {
      const tests = collectTests(file.tasks);
      for (const test of tests) {
        totalDuration += test.result?.duration || 0;
      }
    }
    const duration = (totalDuration / 1000).toFixed(1);

    // Build summary line
    const parts = [`Client: ${files.length} suites`];
    if (passed > 0) parts.push(`${passed} passed`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (failed > 0) parts.push(`${failed} FAILED`);
    parts.push(`(${duration}s)`);
    console.log(parts.join(', '));

    // Print failure details
    if (failed > 0) {
      console.log('\nFAILED:\n');
      failures.forEach(({ file: filepath, test }, i) => {
        const relPath = path.relative(process.cwd(), filepath);
        const testName = getTestPath(test);
        console.log(`${i + 1}) ${relPath} > ${testName}`);

        const errors = test.result?.errors || [];
        for (const err of errors) {
          const msg = err.message || String(err);
          const lines = msg.split('\n');
          let lineNum = null;
          let printed = 0;
          for (const line of lines) {
            const atMatch = line.match(/^\s+at\s.+[:(](\d+):\d+/);
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
      });
    }
  }
}
