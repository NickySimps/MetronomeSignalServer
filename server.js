const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 10000 });
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
          console.log(`Client joined room ${room}`);

          // If two clients are in the room, notify the first client
          if (rooms[room].length === 2) {
            const otherClient = rooms[room][0];
            if (otherClient.readyState === WebSocket.OPEN) {
              otherClient.send(JSON.stringify({ type: 'peer-joined' }));
            }
          }
        }
        break;

      case 'offer':
      case 'answer':
      case 'candidate':
        {
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
