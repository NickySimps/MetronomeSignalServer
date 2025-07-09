const WebSocket = require('ws');

// Use PORT environment variable from Render, fallback to 10000 for local development
const PORT = process.env.PORT || 10000;

const wss = new WebSocket.Server({ port: PORT });
const rooms = {};

console.log(`Signaling server is running on port ${PORT}`);

wss.on('connection', ws => {
  console.log('Client connected');
  
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

    const room = data.room || ws.room;
    if (!room) {
        console.error('No room specified');
        return;
    }

    switch (data.type) {
      case 'join':
        {
          ws.room = room;
          if (!rooms[room]) {
            rooms[room] = [];
          }
          rooms[room].push(ws);
          console.log(`Client joined room ${room}. Room now has ${rooms[room].length} clients.`);

          // If two clients are in the room, notify the first client
          if (rooms[room].length === 2) {
            const otherClient = rooms[room][0];
            if (otherClient.readyState === WebSocket.OPEN) {
              otherClient.send(JSON.stringify({ type: 'peer-joined' }));
              console.log(`Notified first client in room ${room} that peer joined`);
            }
          }
        }
        break;

      case 'offer':
      case 'answer':
      case 'candidate':
        {
          console.log(`Relaying ${data.type} in room ${room}`);
          if (rooms[room]) {
            rooms[room].forEach(client => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
              }
            });
          }
        }
        break;
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clearInterval(pingInterval);
    const room = ws.room;
    if (room && rooms[room]) {
      rooms[room] = rooms[room].filter(client => client !== ws);
      console.log(`Room ${room} now has ${rooms[room].length} clients`);
      if (rooms[room].length === 0) {
        delete rooms[room];
        console.log(`Room ${room} is now empty and closed.`);
      }
    }
  });

  ws.on('error', error => {
    console.error('WebSocket error:', error);
  });
  
  ws.on('pong', () => {
    console.log('Received pong from client');
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
