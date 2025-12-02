const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');

const WS_URL = process.env.WS_URL || 'ws://localhost:3001/s';
const DOC_NAME = process.env.DOC_NAME || 'default-doc';

console.log(`Connecting to ${WS_URL} doc ${DOC_NAME}...`);

const doc = new Y.Doc();
// TipTap uses 'default' field with XmlFragment for ProseMirror content
const xmlFragment = doc.get('default', Y.XmlFragment);

const provider = new WebsocketProvider(WS_URL, DOC_NAME, doc, {
  connect: true
});

let synced = false;

provider.on('status', (event) => {
  console.log('Provider status:', event.status);
});

provider.on('sync', (isSynced) => {
  console.log('Sync event:', isSynced);
  if (isSynced && !synced) {
    synced = true;
    
    // Get current content as text for logging
    const currentText = xmlFragment.toString();
    console.log('Current content length:', currentText.length);
    console.log('Current content preview:', currentText.substring(0, 100));

    const timestamp = new Date().toISOString();
    const message = `[Bot edit ${timestamp}] Edited from Node script.`;
    console.log('Inserting message:', message);
    
    // Insert text into the ProseMirror document
    // We need to create a paragraph node with the text
    const paragraph = new Y.XmlElement('paragraph');
    const textNode = new Y.XmlText();
    textNode.insert(0, message);
    paragraph.insert(0, [textNode]);
    
    // Insert at the end of the fragment
    xmlFragment.insert(xmlFragment.length, [paragraph]);

    setTimeout(() => {
      const finalText = xmlFragment.toString();
      console.log('Final content length:', finalText.length);
      console.log('Final content preview:', finalText.substring(0, 200));
      provider.destroy();
      setTimeout(() => process.exit(0), 500);
    }, 1000);
  }
});

setTimeout(() => {
  console.error('Timed out waiting for sync');
  provider.destroy();
  process.exit(1);
}, 10000);
