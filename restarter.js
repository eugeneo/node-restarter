const ChildProcess = require('child_process');
const Http = require('http');
const WebSocket = require('ws');

const PORT = 9229;
const CHILD_PORT = 9227;

function httpRequest(port, path, callback) {
  Http.get('http://127.0.0.1:' + port + path, response => {
    if (response.statusCode !== 200) {
      throw new Error("HTTP error " + response.statusCode +
          " fetching " + path);
    }
    let buffer = Buffer.alloc(0);
    response
        .on('data', data => {
          buffer = Buffer.concat([buffer, data]);
        })
        .on('end', data => {
          callback(JSON.parse(buffer.toString()));
        });
  });
}

function waitForStart(stream, callback) {
  let buf = Buffer.alloc(0);
  stream.on('data', data => {
    process.stderr.write(data);
    if (buf !== null) {
      buf = Buffer.concat([buf, data]);
      if (buf.toString().match(/Debugger listening on port \d+\./)) {
        buf = null;
        callback();
      }
    }
  });
}

class Inferior {
  constructor(port) {
    this.port_ = port;
    this.frontend_ = null;
    this.connection_ = null;
    this.child_process_ = null;
    this.url_ = null;
    this.starting_ = false;
    this.pendingMessages_ = [];
  }

  setFrontend(frontend) {
    if (frontend && this.frontend_) {
      return false;;
    }
    this.frontend_ = frontend;
    if (frontend) {
      this.connect(null);
      frontend.on('message', message => this.toBackend(message));
      frontend.on('close', () => this.setFrontend(null));
    } else {
      this.connection_.close();
    }
    return true;
  }

  connect(state) {
    if (this.child_process_) {
      const headers =
          state ? {'XInspectorStateCookie' : JSON.stringify(state)} : {};
      const nodeConnection = new WebSocket(this.url_, [], { headers });
      nodeConnection.on('open', () => {
        if (!this.frontend_) {
          nodeConnection.close();
        } else {
          this.connection_ = nodeConnection;
          this.pendingMessages_.forEach(
              message => nodeConnection.send(message));
          this.pendingMessages_ = [];
        }
      });
      nodeConnection.on('message', message => this.toFrontend(message));
      nodeConnection.on('close', () => this.connection_ = null);
    } else {
      this.start();
    }
  }

  consumeMessage(message) {
    const json = JSON.parse(message);
    if (json['method'] == 'Page.reload') {
      this.restartNode(json['id']);
      return true;
    }
    return false;
  }

  kill() {
    if (!this.child_process_)
      return;
    let child_process = this.child_process_;
    this.child_process_ = null;
    child_process.kill();
  }

  toBackend(message) {
    if (!this.consumeMessage(message)) {
      if (this.connection_)
        this.connection_.send(message);
      else
        this.pendingMessages_.push(message);
    }
  }

  restartNode(requestId) {
    httpRequest(this.port_, '/json/__inspector_state/', state => {
      const child_process = this.child_process_;
      this.child_process_ = null;
      child_process.kill();
      this.toFrontend(JSON.stringify({'id': requestId, result: {}}));
      this.start(state);
    });
  }

  toFrontend(message) {
    this.frontend_ && this.frontend_.send(message);
  }

  start(state) {
    if (this.starting_)
      return;
    this.starting_ = true;
    const argv = process.argv;
    const script = argv.length > 2 ? argv[2] : null;
    const args = argv.length > 3 ? argv.slice(3) : [];
    const execArgv = ['--inspect=' + this.port_, '--debug-brk'];
    const subProcess = ChildProcess.fork(script, args, {
      execArgv, stdio: [0, 1, 'pipe', 'ipc'],
    });
    subProcess.on('exit', errorCode => {
      if (this.child_process_)
        process.exit(errorCode);
    });
    waitForStart(subProcess.stderr, () => this.started_(subProcess, state));
  }

  started_(subProcess, state) {
    this.starting_ = false;
    this.child_process_ = subProcess;
    httpRequest(this.port_, '/json/list', response => {
      this.url_ = response[0]['webSocketDebuggerUrl'];
      this.frontend_ && this.connect(state);
    });
  }
}

function main() {
  const inferior = new Inferior(CHILD_PORT);
  const server = Http.createServer();
  server.listen(PORT, function() {
    console.log('Listening on ' + server.address().port);
  });
  const wss = new WebSocket.Server({server});
  wss.on('connection', ws => {
    if (!inferior.setFrontend(ws)) {
      ws.close();
    }
  });
  process.on('uncaughtException', e => {
    inferior.kill();
    throw e;
  });
}

main();
