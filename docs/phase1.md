# Phase 1: MVP Collaborative Editor - Implementation Specification

## Overview

Phase 1 delivers a functional collaborative rich text editor with real-time multi-user editing capabilities. The focus is on establishing core functionality with minimal infrastructure complexity, enabling rapid development and validation of the collaborative editing experience.

**Timeline**: MVP development phase  
**Deployment**: Single-server development/demo environment  
**Users**: Internal testing, early adopters, proof-of-concept demonstrations

## Goals

### Primary Objectives

1. **Demonstrate collaborative editing**: Multiple users can simultaneously edit the same document with changes appearing in real-time
2. **Validate technology choices**: Confirm Yjs + TipTap + Node.js stack meets requirements
3. **Establish foundation**: Create codebase architecture that can evolve into production system
4. **Minimal operational complexity**: Single-server deployment with no external database dependencies

### Non-Goals (Deferred to Later Phases)

- Multi-server deployment
- Production-grade security and authentication
- Horizontal scalability
- Advanced features (comments, version history, permissions)
- Performance optimization beyond reasonable UX
- High availability / disaster recovery

## System Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  React Application                                      │ │
│  │  - TipTap Editor UI                                     │ │
│  │  - Yjs Document (Y.Doc)                                 │ │
│  │  - WebSocket Provider                                   │ │
│  │  - IndexedDB Provider (offline support)                 │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                    WebSocket Connection
                            │
┌─────────────────────────────────────────────────────────────┐
│                    Node.js Server                            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Express HTTP Server                                    │ │
│  │  - Static file serving                                  │ │
│  │  - Basic API endpoints                                  │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  WebSocket Server (y-websocket)                         │ │
│  │  - Connection management                                │ │
│  │  - Message routing                                      │ │
│  │  - In-memory document state                             │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Persistence (y-leveldb)                                │ │
│  │  - File-based storage                                   │ │
│  │  - Automatic document saving                            │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                      File System
                            │
                  ┌──────────────────┐
                  │  LevelDB Storage │
                  │  ./data/         │
                  └──────────────────┘
```

### Technology Stack

**Frontend**:
- React 18+
- TipTap editor
- Yjs core library
- y-websocket (WebSocket provider)
- y-indexeddb (offline persistence)

**Backend**:
- Node.js 18+ (LTS)
- Express.js
- y-websocket server utilities
- y-leveldb persistence provider
- ws (WebSocket library)

**Development**:
- npm or yarn for package management
- Vite or Create React App for frontend tooling
- ESLint for code quality
- Git for version control

## Functional Requirements

### Document Management

**Single Document Focus**: Phase 1 serves exactly one shared document.

- Document ID: Hard-coded or single known identifier
- Document initialization: Create empty document on first server start
- Document persistence: Automatic save to LevelDB on updates
- Document loading: Restore from LevelDB on server restart

### Rich Text Editing

**Supported Formatting**:
- **Text styles**: Bold, italic, underline, strikethrough
- **Headings**: H1, H2, H3
- **Lists**: Bulleted lists, numbered lists
- **Paragraphs**: Normal paragraph formatting
- **Basic inline**: Code snippets

**Not Supported in Phase 1**:
- Images or media embeds
- Tables
- Advanced formatting (text color, background, fonts)
- Links (optional - include if time permits)

### Collaborative Features

**Real-time Sync**:
- Changes appear on all connected clients within 300ms (typical)
- Automatic conflict resolution via Yjs CRDT
- No user intervention required for merging

**User Awareness**:
- Display list of currently connected users
- Show user cursor positions (optional enhancement)
- Indicate user presence (online/offline)

**Offline Support**:
- Users can edit while disconnected
- Changes stored in browser IndexedDB
- Automatic sync when connection restored

### User Interface

**Editor Interface**:
- Clean, distraction-free editing area
- Toolbar with formatting buttons
- Document title (static for Phase 1)
- User presence indicator

**Connection Status**:
- Visual indicator of connection state (connected/disconnected/syncing)
- Reconnection handling with user feedback

**Simple and Functional**:
- No complex navigation
- No user accounts or login (optional: simple name input)
- Focus on editing experience

## Technical Specifications

### Frontend Application

**Entry Point**: Single-page React application

**Core Components**:
- `App`: Root component, manages WebSocket connection
- `Editor`: TipTap editor wrapper with Yjs binding
- `Toolbar`: Formatting controls
- `UserList`: Display connected users
- `ConnectionStatus`: Show sync state

**State Management**:
- Yjs document as source of truth
- React state for UI-only concerns (connection status, user list)
- No Redux/MobX required for Phase 1

**Yjs Setup**:
- Create single Y.Doc instance
- Bind to TipTap editor via collaboration extension
- Connect WebSocket provider to backend
- Enable IndexedDB provider for offline persistence
- Configure awareness for user presence

**Styling**:
- CSS Modules or Styled Components
- Responsive layout (desktop-first)
- Basic styling - polish deferred to later phases

### Backend Server

**Server Initialization**:
- Start Express server on configured port (default: 3000)
- Initialize WebSocket server on same port
- Set up y-websocket connection handler
- Initialize y-leveldb persistence with data directory
- Serve frontend static files from build directory

**WebSocket Handling**:
- Use y-websocket utilities for connection management
- Automatic message routing between clients
- Handle client connect/disconnect events
- Maintain document state in memory while clients connected

**Persistence Strategy**:
- LevelDB storage in `./data/leveldb` directory
- Automatic persistence on document updates
- Document loaded into memory on first connection
- Periodic snapshots (every N seconds or M operations)

**HTTP Endpoints**:
- `GET /`: Serve React application
- `GET /static/*`: Serve static assets
- `GET /health`: Health check endpoint (returns 200 OK)

**Configuration**:
- Environment variables for port, data directory
- Simple configuration file or command-line arguments
- Defaults that work out of the box

### Data Storage

**LevelDB Structure**:
- Key: Document ID
- Value: Serialized Yjs document state (binary)
- Single document with well-known key (e.g., "default-doc")

**Storage Location**:
- `./data/leveldb/` directory relative to server execution
- Created automatically if doesn't exist
- Git-ignored (data not checked in)

**Backup Considerations**:
- Simple file-system backup of `./data/` directory
- No automated backup in Phase 1
- Manual backup procedures documented

## Data Flow

### Initial Document Load

1. User navigates to application URL
2. Browser loads React application
3. React app creates Yjs document instance
4. WebSocket provider connects to server
5. Server checks if client is first connection
6. If first: Load document state from LevelDB
7. Server sends current document state to client
8. Client applies state and renders editor
9. IndexedDB provider syncs with Yjs document

### Real-time Editing

1. User types in editor
2. TipTap captures edit and updates DOM
3. Yjs collaboration extension creates update
4. WebSocket provider sends update to server
5. Server receives update and applies to in-memory document
6. Server broadcasts update to all other connected clients
7. Receiving clients apply update to their Yjs documents
8. TipTap re-renders affected portions
9. Server persists update to LevelDB (debounced)

### Offline Editing

1. User loses network connection
2. WebSocket provider detects disconnect
3. UI shows "offline" status
4. User continues editing normally
5. Yjs updates stored in IndexedDB
6. Connection restored
7. WebSocket provider reconnects
8. Pending updates sent to server
9. Server syncs with other clients
10. UI shows "connected" status

### User Presence

1. User connects to document
2. Awareness protocol shares user info (name, color)
3. Server broadcasts awareness to all clients
4. Clients display user list
5. User moves cursor
6. Awareness updates sent (throttled)
7. Other clients update cursor indicators

