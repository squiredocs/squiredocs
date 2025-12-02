const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');

const WS_URL = process.env.WS_URL || 'ws://localhost:3001/s';
const DOC_NAME = process.env.DOC_NAME || 'default-doc';
const DURATION_SECONDS = parseInt(process.env.DURATION || '60');
const INTERVAL_SECONDS = parseInt(process.env.INTERVAL || '5');

console.log(`Connecting to ${WS_URL} doc ${DOC_NAME}...`);
console.log(`Will make edits every ${INTERVAL_SECONDS} seconds for ${DURATION_SECONDS} seconds`);

const doc = new Y.Doc();
// TipTap uses 'default' field with XmlFragment for ProseMirror content
const xmlFragment = doc.get('default', Y.XmlFragment);

const provider = new WebsocketProvider(WS_URL, DOC_NAME, doc, {
  connect: true
});

let synced = false;
let editCount = 0;
let startTime = Date.now();

provider.on('status', (event) => {
  console.log('Provider status:', event.status);
  if (event.status === 'disconnected') {
    console.error('⚠ Connection lost! Attempting to reconnect...');
  }
});

provider.on('connection-error', (error) => {
  console.error('Connection error:', error);
});

provider.on('sync', (isSynced) => {
  console.log('Sync event:', isSynced);
  if (isSynced && !synced) {
    synced = true;
    console.log('✓ Synced! Starting to make edits...\n');
    startTime = Date.now(); // Reset start time when actually synced
    startMakingEdits();
  }
});

function makeEdit(message, position = 'end') {
  try {
    editCount++;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const timestamp = new Date().toISOString();
    const fullMessage = `[Edit #${editCount} at ${elapsed}s - ${timestamp}] ${message}`;
    
    const positionLabel = position === 'start' ? 'at start' : position === 'middle' ? 'in middle' : 'at end';
    console.log(`Making edit #${editCount} ${positionLabel}: ${message}`);
    
    // Create a paragraph node with the text
    const paragraph = new Y.XmlElement('paragraph');
    const textNode = new Y.XmlText();
    textNode.insert(0, fullMessage);
    paragraph.insert(0, [textNode]);
    
    // Insert at different positions
    const currentLength = xmlFragment.length;
    let insertPosition;
    
    if (position === 'start') {
      insertPosition = 0;
    } else if (position === 'middle') {
      insertPosition = Math.floor(currentLength / 2);
    } else {
      insertPosition = currentLength; // end
    }
    
    xmlFragment.insert(insertPosition, [paragraph]);
    
    console.log(`  ✓ Edit #${editCount} applied successfully at position ${insertPosition}/${currentLength}`);
  } catch (error) {
    console.error(`  ✗ Error making edit #${editCount}:`, error.message);
  }
}

function startMakingEdits() {
  const edits = [
    { message: 'First edit - Hello!', position: 'end' },
    { message: 'Second edit - This is a test', position: 'end' },
    { message: 'Third edit - Inserted at start', position: 'start' },
    { message: 'Fourth edit - Making progress', position: 'end' },
    { message: 'Fifth edit - Inserted in middle', position: 'middle' },
    { message: 'Sixth edit - Still going', position: 'end' },
    { message: 'Seventh edit - Another at start', position: 'start' },
    { message: 'Eighth edit - Wrapping up', position: 'end' },
    { message: 'Ninth edit - Middle insertion', position: 'middle' },
    { message: 'Tenth edit - Almost finished', position: 'end' },
    { message: 'Eleventh edit - One more at start', position: 'start' },
    { message: 'Twelfth edit - Final edit!', position: 'end' }
  ];
  
  let editIndex = 0;
  
  // Make first edit immediately
  if (editIndex < edits.length) {
    const edit = edits[editIndex];
    makeEdit(edit.message, edit.position);
    editIndex++;
  }
  
  const interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    
    if (elapsed >= DURATION_SECONDS) {
      clearInterval(interval);
      console.log(`\n✓ Completed ${editCount} edits over ${DURATION_SECONDS} seconds`);
      console.log('Final content length:', xmlFragment.toString().length);
      provider.destroy();
      setTimeout(() => process.exit(0), 1000);
      return;
    }
    
    try {
      if (editIndex < edits.length) {
        const edit = edits[editIndex];
        makeEdit(edit.message, edit.position);
        editIndex++;
      } else {
        // If we've used all predefined edits, alternate positions
        const positions = ['start', 'middle', 'end'];
        const position = positions[editIndex % 3];
        makeEdit(`Edit number ${editIndex + 1}`, position);
        editIndex++;
      }
    } catch (error) {
      console.error('Error making edit:', error);
    }
  }, INTERVAL_SECONDS * 1000);
  
  // Keep process alive
  process.on('SIGINT', () => {
    clearInterval(interval);
    provider.destroy();
    process.exit(0);
  });
}

// Keep process alive - don't exit on timeout, just log
setTimeout(() => {
  if (!synced) {
    console.error('Warning: Still waiting for sync after 10 seconds...');
    console.log('Provider shouldConnect:', provider.shouldConnect);
    console.log('Provider connected:', provider.ws && provider.ws.readyState === 1);
  }
}, 10000);

// Keep process alive
process.on('SIGINT', () => {
  console.log('\n\nInterrupted. Cleaning up...');
  provider.destroy();
  process.exit(0);
});

// Prevent process from exiting
process.stdin.resume();

