const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');

const WS_URL = 'ws://localhost:3001';
const DOC_NAME = 'default-doc';

console.log('Starting collaboration test...\n');

// Create two Yjs documents to simulate two clients
const doc1 = new Y.Doc();
const doc2 = new Y.Doc();

// Create text types for both documents
const text1 = doc1.getText('content');
const text2 = doc2.getText('content');

let provider1, provider2;
let connected1 = false;
let connected2 = false;

// Helper to create WebSocket provider
function createProvider(doc, text, name) {
  return new Promise((resolve, reject) => {
    const provider = new WebsocketProvider(WS_URL, DOC_NAME, doc, {
      connect: true
    });
    
    provider.on('status', (event) => {
      if (event.status === 'connected') {
        console.log(`[${name}] Connected to server`);
        resolve(provider);
      }
    });
    
    provider.on('sync', (isSynced) => {
      if (isSynced) {
        console.log(`[${name}] Synced, current content: "${text.toString()}"`);
      }
    });
    
    // Listen for updates
    text.observe((event) => {
      console.log(`[${name}] Text changed: "${text.toString()}"`);
    });
    
    provider.on('connection-error', (error) => {
      console.error(`[${name}] Connection error:`, error.message);
      reject(error);
    });
    
    // Timeout after 5 seconds
    setTimeout(() => {
      if (!connected1 && name === 'Client 1') {
        reject(new Error('Client 1 connection timeout'));
      } else if (!connected2 && name === 'Client 2') {
        reject(new Error('Client 2 connection timeout'));
      }
    }, 5000);
  });
}

// Test function
async function testCollaboration() {
  try {
    console.log('Connecting client 1...');
    provider1 = await createProvider(doc1, text1, 'Client 1');
    connected1 = true;
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('\nConnecting client 2...');
    provider2 = await createProvider(doc2, text2, 'Client 2');
    connected2 = true;
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('\n--- Starting edits ---\n');
    
    // Client 1 inserts text
    console.log('[Client 1] Inserting "Hello "');
    text1.insert(0, 'Hello ');
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Check if client 2 received it
    const content2_after_1 = text2.toString();
    console.log(`\n[Client 2] Content after Client 1 edit: "${content2_after_1}"`);
    
    if (content2_after_1 === 'Hello ') {
      console.log('✓ Client 2 received Client 1\'s edit!');
    } else {
      console.log('✗ Client 2 did NOT receive Client 1\'s edit');
      console.log(`  Expected: "Hello "`);
      console.log(`  Got: "${content2_after_1}"`);
    }
    
    // Client 2 inserts text
    console.log('\n[Client 2] Inserting "World!"');
    text2.insert(text2.length, 'World!');
    
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Check if client 1 received it
    const content1_after_2 = text1.toString();
    console.log(`\n[Client 1] Content after Client 2 edit: "${content1_after_2}"`);
    
    if (content1_after_2 === 'Hello World!') {
      console.log('✓ Client 1 received Client 2\'s edit!');
    } else {
      console.log('✗ Client 1 did NOT receive Client 2\'s edit');
      console.log(`  Expected: "Hello World!"`);
      console.log(`  Got: "${content1_after_2}"`);
    }
    
    // Final check
    console.log('\n--- Final Results ---');
    console.log(`[Client 1] Final content: "${text1.toString()}"`);
    console.log(`[Client 2] Final content: "${text2.toString()}"`);
    
    if (text1.toString() === text2.toString() && text1.toString() === 'Hello World!') {
      console.log('\n✓✓✓ COLLABORATION TEST PASSED! ✓✓✓');
      console.log('Both clients are synchronized correctly.');
    } else {
      console.log('\n✗✗✗ COLLABORATION TEST FAILED ✗✗✗');
      console.log('Clients are not synchronized.');
    }
    
    // Cleanup
    provider1.destroy();
    provider2.destroy();
    
    setTimeout(() => {
      process.exit(0);
    }, 500);
    
  } catch (error) {
    console.error('\nTest failed with error:', error);
    if (provider1) provider1.destroy();
    if (provider2) provider2.destroy();
    process.exit(1);
  }
}

// Run test
testCollaboration();
