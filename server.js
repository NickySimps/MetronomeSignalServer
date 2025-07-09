const WebSocket = require('ws');

// Create a WebSocket server on port 10000
const wss = new WebSocket.Server({ port: 10000 });

// A map to store the rooms and the clients in them
const rooms = {};

console.log('Signaling server is running on port 10000');

wss.on('connection', ws => {
  console.log('Client connected');

  ws.on('message', message => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error('Invalid JSON', e);
      return;
    }

    switch (data.type) {
      // When a user tries to join a room
      case 'join':
        {
          const room = data.room;
          if (!rooms[room]) {
            rooms[room] = [];
          }
          rooms[room].push(ws);
          ws.room = room;
          console.log(`Client joined room ${room}`);
        }
        break;

      // When a user sends an offer, answer, or ICE candidate
      case 'offer':
      case 'answer':
      case 'candidate':
        {
          const room = ws.room;
          if (room && rooms[room]) {
            // Forward the message to the other client in the room
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
    // Remove the client from the room
    const room = ws.room;
    if (room && rooms[room]) {
      rooms[room] = rooms[room].filter(client => client !== ws);
      if (rooms[room].length === 0) {
        delete rooms[room];
        console.log(`Room ${room} is now empty and closed.`);
      }
    }
  });

  ws.on('error', error => {
    console.error('WebSocket error:', error);
  });
});