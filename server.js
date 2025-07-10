const WebSocket = require('ws');

// Use PORT environment variable from Render, fallback to 10000 for local development
const PORT = process.env.PORT || 10000;
console.log('Environment PORT:', process.env.PORT);
console.log('Using PORT:', PORT);

const wss = new WebSocket.Server({ port: PORT });
const rooms = {};

console.log(`Multi-client signaling server is running on port ${PORT}`);

// Generate unique peer IDs
function generatePeerId() {
  return Math.random().toString(36).substring(2, 12);
}

// Clean up empty rooms
function cleanupRoom(roomId) {
  if (rooms[roomId] && rooms[roomId].clients.size === 0) {
    delete rooms[roomId];
    console.log(`Room ${roomId} deleted (empty)`);
  }
}

// Broadcast to all clients in a room except sender
function broadcastToRoom(roomId, message, excludeWs = null) {
  if (!rooms[roomId]) return;
  
  rooms[roomId].clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Send message to specific peer in room
function sendToPeer(roomId, peerId, message) {
  if (!rooms[roomId]) return false;
  
  for (const client of rooms[roomId].clients) {
    if (client.peerId === peerId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
      return true;
    }
  }
  return false;
}

wss.on('connection', ws => {
  console.log('Client connected');
  
  // Assign unique peer ID
  ws.peerId = generatePeerId();
  console.log(`Assigned peer ID: ${ws.peerId}`);
  
  // Send a ping every 30 seconds to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);
  
  ws.on('message', message => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error('Invalid JSON', e);
      return;
    }
    
    const roomId = data.room || ws.room;
    if (!roomId) {
      console.error('No room specified');
      return;
    }
    
    switch (data.type) {
      case 'join':
        {
          console.log(`Client ${ws.peerId} joining room ${roomId}`);
          ws.room = roomId;
          
          // Initialize room if it doesn't exist
          if (!rooms[roomId]) {
            rooms[roomId] = {
              clients: new Set(),
              host: null
            };
          }
          
          // Add client to room
          rooms[roomId].clients.add(ws);
          
          // If this is the first client, make them the host
          if (rooms[roomId].clients.size === 1) {
            rooms[roomId].host = ws;
            ws.isHost = true;
            console.log(`Client ${ws.peerId} is now the host of room ${roomId}`);
          } else {
            ws.isHost = false;
            // Notify the host that a new peer joined
            if (rooms[roomId].host && rooms[roomId].host.readyState === WebSocket.OPEN) {
              rooms[roomId].host.send(JSON.stringify({
                type: 'peer-joined',
                peerId: ws.peerId,
                room: roomId
              }));
              console.log(`Notified host that peer ${ws.peerId} joined room ${roomId}`);
            }
          }
          
          console.log(`Room ${roomId} now has ${rooms[roomId].clients.size} clients`);
        }
        break;
        
      case 'offer':
        {
          console.log(`Relaying offer from ${ws.peerId} to ${data.peerId} in room ${roomId}`);
          const targetMessage = {
            type: 'offer',
            offer: data.offer,
            peerId: ws.peerId, // The sender's peer ID
            room: roomId
          };
          
          if (!sendToPeer(roomId, data.peerId, targetMessage)) {
            console.error(`Failed to send offer to peer ${data.peerId} in room ${roomId}`);
          }
        }
        break;
        
      case 'answer':
        {
          console.log(`Relaying answer from ${ws.peerId} to ${data.peerId} in room ${roomId}`);
          const targetMessage = {
            type: 'answer',
            answer: data.answer,
            peerId: ws.peerId, // The sender's peer ID
            room: roomId
          };
          
          if (!sendToPeer(roomId, data.peerId, targetMessage)) {
            console.error(`Failed to send answer to peer ${data.peerId} in room ${roomId}`);
          }
        }
        break;
        
      case 'candidate':
        {
          console.log(`Relaying ICE candidate from ${ws.peerId} to ${data.peerId} in room ${roomId}`);
          const targetMessage = {
            type: 'candidate',
            candidate: data.candidate,
            peerId: ws.peerId, // The sender's peer ID
            room: roomId
          };
          
          if (!sendToPeer(roomId, data.peerId, targetMessage)) {
            console.error(`Failed to send ICE candidate to peer ${data.peerId} in room ${roomId}`);
          }
        }
        break;
        
      default:
        console.log(`Unknown message type: ${data.type}`);
    }
  });
  
  ws.on('close', () => {
    console.log(`Client ${ws.peerId} disconnected`);
    clearInterval(pingInterval);
    
    const roomId = ws.room;
    if (roomId && rooms[roomId]) {
      // Remove client from room
      rooms[roomId].clients.delete(ws);
      
      // If this was the host, we need to handle host migration or room cleanup
      if (ws.isHost) {
        console.log(`Host ${ws.peerId} left room ${roomId}`);
        
        // If there are other clients, make one of them the new host
        if (rooms[roomId].clients.size > 0) {
          const newHost = rooms[roomId].clients.values().next().value;
          rooms[roomId].host = newHost;
          newHost.isHost = true;
          console.log(`Client ${newHost.peerId} is now the host of room ${roomId}`);
          
          // Notify all clients about the host change
          broadcastToRoom(roomId, {
            type: 'host-changed',
            newHostId: newHost.peerId,
            room: roomId
          });
        } else {
          // No clients left, room will be cleaned up
          rooms[roomId].host = null;
        }
      }
      
      // Notify remaining clients that this peer left
      broadcastToRoom(roomId, {
        type: 'peer-left',
        peerId: ws.peerId,
        room: roomId
      }, ws);
      
      console.log(`Room ${roomId} now has ${rooms[roomId].clients.size} clients`);
      
      // Clean up empty room
      cleanupRoom(roomId);
    }
  });
  
  ws.on('error', error => {
    console.error(`WebSocket error for client ${ws.peerId}:`, error);
  });
  
  ws.on('pong', () => {
    console.log(`Received pong from client ${ws.peerId}`);
  });
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  wss.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing server...');
  wss.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
