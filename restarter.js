var child_process = require('child_process');
var http = require('http');
var WebSocket = require('ws');

const PORT = 9229;
const CHILD_PORT = 9227;

const IS_RESTARTING_SYMBOL = Symbol('restarting');
const PORT_SYMBOL = Symbol('port');
const PROCESS_SYMBOL = Symbol('process');
const URL_SYMBOL = Symbol('url');

let child = null;
let frontend = null;
let pendingMessages = [];

function httpRequest(port, path, callback) {
  http.get('http://127.0.0.1:' + port + path, response => {
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

function postMessageToFrontend(message) {
  frontend.send(message);
}

function restartNode(child, requestId) {
  const connection = child;
  const child_process = child[PROCESS_SYMBOL];
  const port = child[PORT_SYMBOL];
  child = null;
  httpRequest(port, '/json/__inspector_state/', state => {
    child_process[IS_RESTARTING_SYMBOL] = true;
    connection.close();
    child_process.kill();
    postMessageToFrontend(JSON.stringify({'id': requestId, result: {}}));
    postMessageToFrontend(JSON.stringify({
      'message': 'Runtime.executionContextDestroyed',
      'params':{'executionContextId':1}
    }));
    postMessageToFrontend(JSON.stringify({
      'message': 'Runtime.executionContextsCleared',
      'params':{}
    }));
    startNode_(port, JSON.stringify(state));
  });
}

function consumeMessage(message) {
  const json = JSON.parse(message);
  if (json['method'] == 'Page.reload') {
    const connection = child;
    child = null;
    restartNode(connection, json['id']);
    return true;
  }
  return false;
}

function postMessageFromFrontend(message) {
  if (!child) {
    pendingMessages.push(message);
  } else if (!consumeMessage(message)) {
    child.send(message);
  }
}

function frontendConnected(ws) {
  if (frontend) {
    ws.close();
    return;
  }
  frontend = ws;
  ws.on('close', () => {
    child.close();
    child = null;
    frontend = null;
  });
  ws.on('message', message => {
    postMessageFromFrontend(message);
  });
  return true;
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

function connectToChild(subProcess, state, url, port) {
    subProcess[URL_SYMBOL] = url;
    const headers = state ? {'XInspectorStateCookie' : state} : {};
    const nodeConnection = new WebSocket(subProcess[URL_SYMBOL], [], { headers });
    nodeConnection[PORT_SYMBOL] = port
    nodeConnection[PROCESS_SYMBOL] = subProcess;
    nodeConnection.on('open', () => {
      child = nodeConnection;
    });
    nodeConnection.on('message', postMessageToFrontend);
}

function startNode_(port, state) {
  const argv = process.argv;
  const script = argv.length > 2 ? argv[2] : null;
  const args = argv.length > 3 ? argv.slice(3) : [];

  const execArgv = ['--inspect=' + port];
  if (!state)
    execArgv.push('--debug-brk');

  const subProcess = child_process.fork(script, args, {
    execArgv, stdio: [0, 1, 'pipe', 'ipc'],
  });
  subProcess.on('exit', errorCode => {
    if (!subProcess[IS_RESTARTING_SYMBOL]) process.exit(errorCode);
  });

  const connect =
      (url => connectToChild(subProcess, state, url, port));
  waitForStart(subProcess.stderr, () => httpRequest(port, '/json/list',
    targets => connect(targets[0]['webSocketDebuggerUrl'])));
}

const server = http.createServer();
server.listen(PORT, function() {
  console.log('Listening on ' + server.address().port);
});
const wss = new WebSocket.Server({server});
wss.on('connection', frontendConnected);

process.on('uncaughtException', e => {
  const proc = child && child[PROCESS_SYMBOL];
  proc && proc.kill();
  throw e;
});
startNode_(CHILD_PORT);
