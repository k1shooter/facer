const express = require('express');
const app = express();

app.listen(80, '0.0.0.0', function () {
    console.log('listening on 80');
  });

app.get('/posts', (req, res) => {
  db.query('select * from posts', (err, data) => {
    if (!err) {
      console.log(data);
      res.send(data);
    } else {
      res.send(err);
    }
  });
});

app.get('/', function (요청, 응답) {
  응답.sendFile(__dirname + '/index.html');
});


