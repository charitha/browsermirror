/* Channel abstraction.  Supported channels:

- WebSocket to an address
- port.emit/port.on proxying
- postMessage between windows

In the future:

- XMLHttpRequest to a server (with some form of queuing)

The interface:

  channel = new ChannelName(parameters)

The instantiation is per-channel-type

Methods:

  onmessage: set to function (jsonData)
  rawdata: set to true if you want onmessage to receive raw string data
  onclose: set to function ()
  onopen: set to function ()
  send: function (string or jsonData)
  close: function ()

.send() will encode the data if it is not a string.

(should I include readyState as an attribute?)

Channels must accept messages immediately, caching if the connection
is not fully established yet.

*/

function AbstractChannel() {
  this.constructor.apply(this, arguments);
}
/* Subclasses must define:

- ._send(string)
- ._setupConnection()
- ._ready()
- .close() (and must set this.closed to true)

And must call:

- ._flush() on open
- ._incoming(string) on incoming message
- onclose()/onopen() (not onmessage - instead _incoming)
*/


AbstractChannel.subclass = function (overrides) {
  var C = function () {
    this.constructor.apply(this, arguments);
    this.baseConstructor.apply(this, arguments);
  };
  C.prototype = new AbstractChannel();
  for (var i in overrides) {
    if (overrides.hasOwnProperty(i)) {
      C.prototype[i] = overrides[i];
    }
  }
  return C;
};

AbstractChannel.prototype = {
  onmessage: null,
  rawdata: false,
  onclose: null,
  onopen: null,
  closed: false,

  baseConstructor: function () {
    this._buffer = [];
    this._setupConnection();
  },

  send: function (data) {
    if (this.closed) {
      throw 'Cannot send to a closed connection';
    }
    if (typeof data != "string") {
      data = JSON.stringify(data);
    }
    if (! this._ready()) {
      this._buffer.push(data);
      return;
    }
    this._send(data);
  },

  _flush: function () {
    for (var i=0; i<this._buffer.length; i++) {
      this._send(this._buffer[i]);
    }
    this._buffer = [];
  },

  _incoming: function (data) {
    if (! this.rawdata) {
      data = JSON.parse(data);
    }
    if (this.onmessage) {
      this.onmessage(data);
    }
  }

};


var WebSocketChannel = AbstractChannel.subclass({

  constructor: function (address) {
    if (address.search(/^https?:/i) === 0) {
      address = address.replace(/^http/i, 'ws');
    }
    this.address = address;
    this.socket = null;
    this._reopening = false;
  },

  close: function () {
    this.closed = true;
    if (this.socket) {
      // socket.onclose will call this.onclose:
      this.socket.close();
    } else {
      if (this.onclose) {
        this.onclose();
      }
    }
  },

  _send: function (data) {
    this.socket.send(data);
  },

  _ready: function () {
    return this.socket && this.socket.readyState == this.socket.OPEN;
  },

  _setupConnection: function () {
    if (this.closed) {
      return;
    }
    this.socket = new WebSocket(this.address);
    this.socket.onopen = (function () {
      this._flush();
      if ((! this._reopening) && this.onopen) {
        this.onopen();
      }
      this._reopening = false;
    }).bind(this);
    this.socket.onclose = (function () {
      this.socket = null;
      console.log('WebSocket close', event.wasClean ? 'clean' : 'unclean',
                  'code:', event.code, 'reason:', event.reason || 'none');
      if (! this.closed) {
        this._reopening = true;
        this._setupConnection();
      }
    }).bind(this);
    this.socket.onmessage = (function (event) {
      this._incoming(event.data);
    }).bind(this);
    this.socket.onerror = (function (event) {
      console.log('WebSocket error:', event.data);
    }).bind(this);
  }

});


/* Sends TO a window or iframe */
var PostMessageChannel = AbstractChannel.subclass({
  _pingPollPeriod: 100, // milliseconds

  constructor: function (win, expectedOrigin) {
    this.expectedOrigin = expectedOrigin;
    this._pingReceived = false;
    this._receiveMessage = this._receiveMessage.bind(this);
    if (win) {
      this.bindWindow(win, true);
    }
  },

  bindWindow: function (win, noSetup) {
    if (win && win.contentWindow) {
      win = win.contentWindow;
    }
    this.window = win;
    this.window.addEventListener("message", this._receiveMessage, false);
    if (! noSetup) {
      this._setupConnection();
    }
  },

  _send: function (data) {
    this.window.postMessage(data, this.expectedOrigin || "*");
  },

  _ready: function () {
    return this.window && this._pingReceived;
  },

  _setupConnection: function () {
    if (this.closed || this._pingReceived) {
      return;
    }
    if (! this.window) {
      return;
    }
    this.window.postMessage("hello", this.expectedOrigin || "*");
    // We'll keep sending ping messages until we get a reply
    this._pingTimeout = setTimeout(this._setupConnection.bind(this), this._pingPollPeriod);
  },

  _receiveMessage: function (event) {
    if (this.expectedOrigin && event.origin != this.expectedOrigin) {
      console.info("Expected message from", this.expectedOrigin,
                   "but got message from", event.origin);
      return;
    }
    if (! this.expectedOrigin) {
      this.expectedOrigin = event.origin;
    }
    if (event.data == "hello") {
      this._pingReceived = true;
      if (this._pingTimeout) {
        clearTimeout(this._pingTimeout);
        this._pingTimeout = null;
      }
      if (this.onopen) {
        this.onopen();
      }
      this._flush();
      return;
    }
    this._incoming(event.data);
  },

  close: function () {
    this.closed = true;
    this.window.removeEventListener("message", this._receiveMessage, false);
    if (this.onclose) {
      this.onclose();
    }
  }

});

if (typeof exports != "undefined") {
  exports.PostMessageChannel = PostMessageChannel;
}


/* Handles message FROM an exterior window/parent */
var PostMessageIncomingChannel = AbstractChannel.subclass({

  constructor: function (expectedOrigin) {
    this.source = null;
    this.expectedOrigin = expectedOrigin;
    this._receiveMessage = this._receiveMessage.bind(this);
    window.addEventListener("message", this._receiveMessage, false);
  },

  _send: function (data) {
    this.source.postMessage(data, this.expectedOrigin);
  },

  _ready: function () {
    return !!this.source;
  },

  _setupConnection: function () {
  },

  _receiveMessage: function (event) {
    if (this.expectedOrigin && event.origin != this.expectedOrigin) {
      // FIXME: Maybe not worth mentioning?
      console.info("Expected message from", this.expectedOrigin,
                   "but got message from", event.origin);
      return;
    }
    if (! this.expectedOrigin) {
      this.expectedOrigin = event.origin;
    }
    if (! this.source) {
      this.source = event.source;
    }
    if (event.data == "hello") {
      // Just a ping
      event.source.postMessage("hello", this.expectedOrigin);
      return;
    }
    this._incoming(event.data);
  },

  close: function () {
    this.closed = true;
    window.removeEventListener("message", this._receiveMessage, false);
    if (this.onclose) {
      this.onclose();
    }
  }

});

if (typeof exports != "undefined") {
  exports.PostMessageIncomingChannel = PostMessageIncomingChannel;
}

/* This proxies to another channel located in another process, via port.emit/port.on */
var PortProxyChannel = AbstractChannel.subclass({

  constructor: function (prefix, self_) {
    this.prefix = prefix || '';
    this.self = self_ || self;
    this._incoming = this._incoming.bind(this);
    this._remoteOpened = this._remoteOpened.bind(this);
  },

  _setupConnection: function () {
    this.self.port.on(this.prefix + "IncomingData", this._incoming);
    this.self.port.on(this.prefix + "Opened", this._remoteOpened);
  },

  _ready: function () {
    // FIXME: is any kind of ping necessary?
    return true;
  },

  _send: function (data) {
    this.self.port.emit(this.prefix + "SendData", data);
  },

  close: function () {
    this.self.port.emit(this.prefix + "Close");
    this.self.port.removeListener(this.prefix + "IncomingData", this._incoming);
    this.self.port.removeListener(this.prefix + "Opened", this._remoteOpened);
    this.closed = true;
    if (this.onclose) {
      this.onclose();
    }
  },

  _remoteOpened: function () {
    // Note this isn't the same as _ready, because we rely on the
    // remote connection to do caching/buffering
    if (this.onopen) {
      this.onopen();
    }
  }

});


/* Will handle incoming requests for the given channel over a port.
Returns a function that tears down this connection.  The teardown
happens automatically on close. */
function PortIncomingChannel(channel, prefix, self_) {
  prefix = prefix || '';
  self_ = self_ || self;
  function remoteSendData(data) {
    channel.send(data);
  }
  function remoteClose() {
    self_.port.removeListener(prefix + "SendData", remoteSendData);
    self_.port.removeListener(prefix + "Close", remoteClose);
    channel.close();
  }
  self_.port.on(prefix + "SendData", remoteSendData);
  self_.port.on(prefix + "Close", remoteClose);
  channel.rawdata = true;
  channel.onmessage = function (data) {
    self_.port.emit(prefix + "IncomingData", data);
  };
  channel.onopen = function () {
    self_.port.emit(prefix + "Opened");
  };
  channel.onclose = function () {
    // FIXME: call remoteClose?
    self_.port.emit(prefix + "Closed");
  };
  return remoteClose;
}

/* Echos all the connection proxying from from_ (the worker that wants
a connection) to to_ (the worker that actually implements the
connection).  Returns a function that will tear down the connection. */
function EchoProxy(from_, to_, prefix) {
  prefix = prefix || '';
  var bindings = [];
  function echo(name, source, dest) {
    function echoer() {
      var args = [name];
      for (var i=0; i<arguments.length; i++) {
        args.push(arguments[i]);
      }
      dest.port.emit.apply(dest.port, args);
    }
    source.port.on(name, echoer);
    bindings.push([source.port, name, echoer]);
  }
  function removeBindings() {
    for (var i=0; i<bindings.length; i++) {
      bindings[i][0].removeListener(bindings[i][1], bindings[i][2]);
    }
  }
  echo(prefix + "IncomingData", to_, from_);
  echo(prefix + "Opened", to_, from_);
  echo(prefix + "Closed", to_, from_);
  echo(prefix + "SendData", from_, to_);
  echo(prefix + "Close", from_, to_);
  return {
    close: removeBindings,
    send: function (data) {
      if (typeof data != "string") {
        data = JSON.stringify(data);
      }
      to_.port.send(prefix + "SendData", data);
    }
  };
}

if (typeof exports != "undefined") {
  exports.EchoProxy = EchoProxy;
}
