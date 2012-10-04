// Copyright 2012 Joyent, Inc.  All rights reserved.

var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');
var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var clone = require('clone');
var carrier = require('carrier');
var httpSignature = require('http-signature');
var MemoryStream = require('memorystream');
var mime = require('mime');
var restify = require('restify');
var uuid = require('node-uuid');
var vasync = require('vasync');



///--- Globals

var sprintf = util.format;

mime.define({
        'application/x-json-stream; type=directory': ['directory'],
        'application/x-json-stream; type=job': ['job']
});

var SIGNATURE = 'Signature keyId="/%s/keys/%s",algorithm="%s" %s';
var STOR_RE = /^\/(\w+)\/stor/;
/* JSSTYLED */
var JOBS_STOR_RE = /^\/(\w+)\/jobs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/stor/;


///--- Errors

function ChecksumError(actual, expected) {
        Error.call(this);

        this.name = 'ChecksumError';
        this.message = sprintf('content-md5 expected to be %s, but was %s',
                               expected, actual);
        Error.captureStackTrace(this, ChecksumError);
}
util.inherits(ChecksumError, Error);


function InvalidDirectoryError(dir) {
        Error.call(this);

        this.name = 'InvalidDirectoryError';
        this.message = dir + ' is an invalid manta directory';
        Error.captureStackTrace(this, InvalidDirectoryError);
}
util.inherits(InvalidDirectoryError, Error);


function StreamFailedError(p) {
        Error.call(this);

        this.name = 'StreamFailedError';
        this.message = 'stream failed for ' + p;
        Error.captureStackTrace(this, StreamFailedError);
}
util.inherits(StreamFailedError, Error);



///--- Helpers

function cloneJob(job) {
        if (typeof (job) === 'string') {
                return ({phases: [{exec: job}]});
        } else if (Array.isArray(job)) {
                return ({
                        phases: job.map(function (j) {
                                if (typeof (j) === 'object') {
                                        return (j);
                                } else if (typeof (j) === 'string') {
                                        return ({
                                                exec: j
                                        });
                                } else {
                                        throw new TypeError(util.inspect(j) +
                                                            ' invalid');
                                }
                        })
                });
        } else if (typeof (job) === 'object') {
                return (clone(job));
        } else {
                throw new TypeError('job (object) required');
        }
}


function createOptions(opts, userOpts) {
        assert.object(opts, 'options');
        assert.string(opts.path, 'options.path');
        assert.object(userOpts, 'userOptions');

        var id = opts.req_id || uuid.v4();
        var options = {
                headers: clone(userOpts.headers || {}),
                id: id,
                path: opts.path.replace(/\/$/, ''),
                query: clone(userOpts.query || {})
        };


        options.headers.accept = options.headers.accept || opts.accept || '*/*';

        if (options.headers['content-length'] || opts.contentLength) {
                options.headers['content-length'] =
                        options.headers['content-length'] ||
                        opts.contentLength;
        }

        if (options.headers['content-md5'] || opts.contentMD5) {
                options.headers['content-md5'] =
                        options.headers['content-md5'] ||
                        opts.contentMD5;
        }

        if (options.headers['content-type'] || opts.contentType) {
                options.headers['content-type'] =
                        options.headers['content-type'] ||
                        opts.contentType;
        }

        options.headers.date = new Date().toUTCString();

        if (options.headers.expect || opts.expect) {
                options.headers.expect = options.headers.expect || opts.expect;
        }

        if (options.headers.location || opts.location) {
                options.headers.location =
                        options.headers.location ||
                        opts.location;
        }

        options.headers['x-request-id'] = options.headers['x-request-id'] || id;

        if (opts.limit)
                options.query.limit = options.query.limit || opts.limit;

        if (opts.offset)
                options.query.offset = options.query.offset || opts.offset;

        return (options);
}


function createRestifyClient(opts, type) {
        var client = restify.createClient({
                agent: opts.agent || false,
                connectTimeout: opts.connectTimeout,
                headers: opts.headers,
                log: opts.log,
                pooling: opts.pooling,
                retry: opts.retry,
                type: type,
                url: opts.url,
                version: '~1.0'
        });

        return (client);
}



function getPath(p, user) {
        var _path;

        if (user) {
                if (STOR_RE.test(p) || JOBS_STOR_RE.test(p)) {
                        _path = p;
                } else {
                        _path = '/' + user + '/stor/' + p;
                }
        } else {
                _path = p;
        }

        return (path.normalize(_path));
}


function getJobPath(p, user) {
        var _path;

        if (user) {
                _path = '/' + user + '/jobs/' + p;
        } else {
                _path = p;
        }

        return (path.normalize(_path).replace(/\/$/, ''));
}


function onRequestCallback(opts) {
        function onRequest(err, req) {
                if (err) {
                        opts.log.debug(err, '%s: error', opts.name);
                        opts.cb(err);
                } else {
                        req.once('result', opts.onResult);
                        if (opts.reqCb) {
                                opts.reqCb(req);
                        }
                }
        }

        return (onRequest);
}


function onResultCallback(opts) {
        function onResult(err, res) {
                if (err) {
                        readError(err, res, function onReadDone() {
                                opts.log.debug(err, '%s: error', opts.name);
                                opts.cb(err);
                        });
                } else {
                        res.once('end', function onEnd() {
                                opts.log.debug('%s: done', opts.name);
                                opts.cb(null, res.headers);
                        });
                }
        }

        return (onResult);
}


function onResultCarrierCallback(opts) {
        var emitter = opts.emitter;
        var log = opts.log;
        var name = opts.name;

        function onResult(err, res) {
                if (err) {
                        readError(err, res, function () {
                                log.debug(err, '%s: error', name);
                                emitter.emit('error', err);
                        });
                        return;
                }

                var carry = carrier.carry(res);
                carry.on('line', function onLine(line) {
                        log.debug({line: line}, '%s: line received', name);
                        opts.emitCb(res, line);
                });

                res.once('end', function ls_onEnd() {
                        carry.removeAllListeners('line');
                        var trailers = res.trailers || {};
                        if (trailers['x-stream-error'] !== 'false') {
                                emitter.emit('error',
                                             new StreamFailedError(opts.path));
                        } else {
                                log.debug('%s: done', name);
                                emitter.emit('end');
                        }
                });

                return;
        }

        return (onResult);
}


function readError(err, res, cb) {
        assert.object(err);
        assert.object(res);
        assert.func(cb);

        if (res === null)
                return (cb(null, err));

        var body = '';
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
                body += chunk;
        });

        res.once('end', function () {
                err._body = body;

                try {
                        err.body = JSON.parse(body);
                } catch (e) {
                }

                err.body = err.body || {};
                err.code = err.body.code;
                err.message = err.body.message;
                err.name = err.body.code;
                if (!/.*Error$/.test(err.name))
                        err.name += 'Error';

                cb(null, err);
        });

        return (undefined);
}


function signRequest(opts, cb) {
        assert.object(opts, 'options');
        assert.object(opts.headers, 'options.headers');
        assert.func(opts.sign, 'options.sign');
        assert.func(cb, 'callback');

        opts.sign(opts.headers.date, function (err, obj) {
                if (err)
                        return (cb(err));

                opts.headers.authorization = sprintf(SIGNATURE,
                                                     obj.user,
                                                     obj.keyId,
                                                     obj.algorithm,
                                                     obj.signature);

                return (cb(null));
        });
}



///--- API


/**
 * Constructor, but you don't use this directly. use createClient({...});
 * instead which wraps this, and will fill in defaults for you.
 *
 * Parameters (nested under options):
 *  - connectTimeout: 0 to disable (default), or number of ms to wait
 *  - headers: optional object block of headers to always send
 *  - log: bunyan logger instance (this toolkit logs at debug)
 *  - sign: callback function to use for signing (authenticated requests)
 *  - url: url of manta
 *  - user: optionally specify a user. If you don't set this, you'll need to
 *          fully qualify paths, like `/mark/stor/foo`, as opposed to setting
 *          it, and just setting paths like UNIX: `/foo`.
 *
 * Throws TypeError's if you pass bad arguments.
 */
function MantaClient(options) {
        assert.object(options, 'options');
        assert.number(options.connectTimeout, 'options.connectTimeout');
        assert.optionalObject(options.headers, 'options.headers');
        assert.object(options.log, 'options.log');
        assert.func(options.sign, 'options.sign');
        assert.string(options.url, 'options.url');
        assert.optionalString(options.user, 'options.user');

        EventEmitter.call(this);

        var self = this;
        this.log = options.log.child({component: 'MantaClient'}, true);
        var restifyOpts = {
                agent: options.agent,
                connectTimeout: options.connectTimeout,
                headers: options.headers || {},
                log: self.log,
                pooling: options.pooling,
                retry: options.retry,
                type: 'http',
                url: options.url,
                version: '~1.0'
        };

        this.client = createRestifyClient(restifyOpts, 'http');
        this.jsonClient = createRestifyClient(restifyOpts, 'json');
        this.sign = options.sign;
        this.user = options.user || false;

        // debugging only
        this._url = options.url;
        this._version = '~1.0';
}
util.inherits(MantaClient, EventEmitter);
module.exports = MantaClient;


/**
 *  Cursory .toString() override so you know something about this object.
 */
MantaClient.prototype.toString = function toString() {
        var str = sprintf('[object MantaClient<url=%s, user=%s, version=%s]',
                          this._url, this.user || 'null', this._version);
        return (str);
};


///--- Storage API

/**
 * Fetches an object back from Manta, and gives you a (standard) ReadableStream.
 *
 * Note this API will validate ContentMD5, and so if the downloaded object does
 * not match, the stream will emit an error.
 *
 * Parameters:
 *  - p: string path
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, stream)
 */
MantaClient.prototype.get = function get(p, opts, cb) {
        assert.string(p, 'path');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.func(cb, 'callback');

        var _path = getPath(p, this.user);
        var options = createOptions({
                accept: opts.accept || '*/*',
                path: _path
        }, opts);
        var log = this.log.child({
                path: _path,
                req_id: options.id
        }, true);
        var self = this;

        function onResult(err, res) {
                if (err) {
                        readError(err, res, function () {
                                log.debug(err, 'get: error');
                                cb(err);
                        });
                        return;
                }

                res.pause();

                var hash = crypto.createHash('md5');
                var stream = new MemoryStream();
                cb(null, stream);

                res.pipe(stream, {end: false});

                res.on('data', function onData(chunk) {
                        hash.update(chunk);
                });

                res.once('end', function onEnd() {
                        log.debug('get: done');
                        var _md5 = res.headers['content-md5'];
                        var md5 = hash.digest('base64');
                        if (_md5 && md5 !== _md5) {
                                stream.emit('error',
                                            new ChecksumError(md5, _md5));
                        } else {
                                stream.end();
                        }
                });

                process.nextTick(function () {
                        res.resume();
                });
        }

        log.debug(options, 'get: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.client.get(options, onRequestCallback({
                        cb: cb,
                        log: log,
                        name: 'get',
                        onResult: onResult
                }));

                return;
        });
};


/**
 * Performs a HEAD request on a key in manta, and gives you back a high-level
 * information block of it.
 *
 * For example, on a directory, you'd get this:
 * {
 *   extension: 'directory',
 *   type: 'application/json; type=directory'
 * }
 *
 * Whereas on an object, you'd get (as an example):
 *
 * {
 *   extension: '.txt',
 *   type: 'text/plain',
 *   etag: 123456...,
 *   md5: AA...,
 *   size: 1024
 * }
 *
 * So you probably want to switch on `type`, which is really the content-type.
 *
 * Parameters:
 *  - p: string path
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, info)
 */
MantaClient.prototype.info = function info(p, opts, cb) {
        assert.string(p, 'path');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.object(opts, 'options');
        assert.func(cb, 'callback');

        var _path = getPath(p, this.user);
        var options = createOptions({
                accept: 'application/json, */*',
                path: _path
        }, opts);
        var log = this.log.child({
                path: _path,
                req_id: options.id
        }, true);
        var self = this;

        function onResult(err, res) {
                if (err) {
                        readError(err, res, function () {
                                log.debug(err, 'ls: error');
                                cb(err);
                        });
                        return;
                }

                res.once('end', function onEnd() {
                        var ct = res.headers['content-type'];
                        var headers = res.headers;
                        var _info = {
                                name: path.basename(_path),
                                extension: mime.extension(ct),
                                type: ct

                        };
                        if (headers.etag)
                                _info.etag = headers.etag;
                        if (headers['content-md5'])
                                _info.md5 = headers['content-md5'];
                        if (headers['content-length'])
                                _info.size = headers['content-length'];

                        log.debug(_info, 'info: done');
                        cb(null, _info);
                });
        }

        log.debug(options, 'info: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.client.head(options, onRequestCallback({
                        cb: cb,
                        log: log,
                        name: 'info',
                        onResult: onResult
                }));

                return;
        });
};


/**
 * Creates a `link` in Manta from an existing object to a new name.
 *
 * As explained elsewhere, this is neither a copy nor a "UNIX link". This is
 * really just setting a new name to point at an existing blob of data.
 *
 * Parameters:
 *  - src: path to existing object
 *  - p: string path to create
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.ln = function ln(src, p, opts, cb) {
        assert.string(src, 'source');
        assert.string(p, 'path');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.object(opts, 'options');
        assert.func(cb, 'callback');

        var _path = getPath(p, this.user);
        var _src = getPath(src, this.user);
        var options = createOptions({
                accept: 'application/json',
                contentType: 'application/json; type=link',
                location: _src,
                path: _path
        }, opts);
        var log = this.log.child({
                path: _path,
                source: _src,
                req_id: options.id
        }, true);
        var self = this;

        log.debug(options, 'ln: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.client.put(options, onRequestCallback({
                        cb: cb,
                        log: log,
                        name: 'ln',
                        onResult: onResultCallback({
                                cb: cb,
                                log: log,
                                name: 'ln'
                        }),
                        reqCb: function (req) {
                                req.end();
                        }
                }));

                return;
        });
};


/**
 * Performs a directory listing, and gives you the result back as a stream.
 *
 * Note that if you attempt to call this on a non-directory, this call will
 * error out.
 *
 * Once you are listing a directory, the callback will give you an
 * EventEmitter, and you can watch for 'directory' or 'object' events, like so:
 *
 * client.ls('/', function (err, res) {
 *     assert.ifError(err);
 *
 *     res.on('object', function (obj) {
 *         console.log(obj);
 *     });
 *
 *     res.on('directory', function (dir) {
 *         console.log(dir);
 *     });
 *
 *     res.once('end', function () {
 *         console.log('all done');
 *     });
 * });
 *
 * Parameters:
 *  - dir: path to directory
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, emitter)
 */
MantaClient.prototype.ls = function ls(dir, opts, cb) {
        assert.string(dir, 'directory');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.object(opts, 'options');
        assert.func(cb, 'callback');

        var directory = getPath(dir, this.user);
        var emitter = new EventEmitter();
        var options = createOptions({
                accept: 'application/x-json-stream',
                limit: opts.limit || 1024,
                offset: opts.offset || 0,
                path: directory
        }, opts);
        var log = this.log.child({
                path: directory,
                req_id: options.id
        }, true);
        var self = this;

        log.debug('ls: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.client.get(options, onRequestCallback({
                        cb: cb,
                        log: log,
                        name: 'ls',
                        onResult: onResultCarrierCallback({
                                emitter: emitter,
                                emitCb: function (res, line) {
                                        var l;

                                        try {
                                                l = JSON.parse(line);
                                        } catch (e) {
                                                log.warn({
                                                        line: line,
                                                        err: e
                                                }, 'ls: invalid JSON data');
                                                res.removeAllListeners('data');
                                                res.removeAllListeners('end');
                                                res.removeAllListeners('error');
                                                emitter.emit('error', e);

                                        }

                                        emitter.emit(l.type, l);
                                },
                                log: log,
                                name: 'ls'
                        }),
                        reqCb: function () {
                                cb(null, emitter);
                        }
                }));

                return;
        });
};


/**
 * Called mkdir, but really this is putdir, as it will let you call mkdir on an
 * already existing directory.
 *
 * Parameters:
 *  - dir: path to directory
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.mkdir = function mkdir(dir, opts, cb) {
        assert.string(dir, 'directory');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.object(opts, 'options');
        assert.func(cb, 'callback');

        var directory = getPath(dir, this.user);
        var options = createOptions({
                accept: 'application/json',
                contentType: 'application/json; type=directory',
                path: directory
        }, opts);
        var log = this.log.child({
                path: directory,
                req_id: options.id
        }, true);
        var self = this;

        log.debug(options, 'mkdir: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.client.put(options, onRequestCallback({
                        cb: cb,
                        log: log,
                        name: 'mkdir',
                        onResult: onResultCallback({
                                cb: cb,
                                log: log,
                                name: 'mkdir'
                        }),
                        reqCb: function (req) {
                                req.end();
                        }
                }));

                return;
        });
};


/**
 * Good old mkdirp. If any key along the way exists and isn't a directory,
 * this will error out.
 *
 * Parameters:
 *  - dir: path to directory
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.mkdirp = function mkdirp(dir, opts, cb) {
        assert.string(dir, 'directory');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.object(opts, 'options');
        assert.func(cb, 'callback');

        var d = getPath(dir, this.user);
        var dirs;
        var id = opts.req_id || uuid.v4();
        var log = this.log.child({
                path: d,
                req_id: id
        }, true);
        var _opts = {
                headers: opts.headers,
                req_id: id
        };
        var self = this;
        var tasks = [];

        log.debug('mkdirp: entered');

        dirs = d.split(/^\/\w+\/stor/).pop();
        if (!dirs) {
                process.nextTick(cb.bind(null, new InvalidDirectoryError(d)));
                return;
        }

        dirs = dirs.split('/');
        dirs.shift();
        if (dirs.length === 0) {
                process.nextTick(cb.bind(null, new InvalidDirectoryError(d)));
                return;
        }

        dirs.forEach(function (_d, i) {
                var tmp = dirs.slice(0, i).join('/');
                var _dir = path.normalize(sprintf('/%s/%s', tmp, _d));

                tasks.push(function _mkdir(_, _cb) {
                        self.mkdir(_dir, _opts, _cb);
                });
        });

        vasync.pipeline({funcs: tasks}, function (err) {
                log.debug(err, 'mkdirp: %s', err ? 'failed' : 'done');
                cb(err || null);
        });
};


/**
 * Creates or overwrites an (object) key.  You pass it in a ReadableStream (note
 * that stream *must* support pause/resume), and upon receiving a 100-continue
 * from manta, the bytes get blasted up.
 *
 * Unlike the other APIs, you also will need to pass in an options object, that
 * contains, at minimum, a 'size' attribute. Additionally, you can/should pass
 * in an 'md5' attribute, and you can pass a 'type' attribute which is really
 * the content-type.  If you don't pass in 'type', this API will try to guess it
 * based on the name of the object (using the extension).  Lastly, you can pass
 * in a 'copies' attribute, which sets the number of full object copies to make
 * server side (default is 2).
 *
 * However, like the other APIs, you can additionally pass in extra headers,
 * etc. in the options object as well.
 *
 * Parameters:
 *  - p: path to object
 *  - input: ReadableStream where we suck bytes from
 *  - opts: see above
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.put = function put(p, input, opts, cb) {
        assert.string(p, 'path');
        assert.stream(input, 'input');
        assert.object(opts, 'options');
        assert.number(opts.size, 'options.size');
        assert.func(cb, 'callback');

        input.pause();

        var _path = getPath(p, this.user);
        var options = createOptions({
                accept: 'application/json',
                contentMD5: opts.md5,
                contentType: (opts.type ||
                              mime.lookup(_path) ||
                              'application/octet-stream'),
                contentLength: opts.size,
                expect: '100-continue',
                path: _path
        }, opts);
        var log = this.log.child({
                path: _path,
                req_id: options.id
        }, true);
        var self = this;

        if (opts.copies) {
                options.headers['x-durability-level'] =
                        parseInt(opts.copies, 10);
        }

        log.debug(options, 'put: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.client.put(options, onRequestCallback({
                        cb: cb,
                        log: log,
                        name: 'put',
                        onResult: onResultCallback({
                                cb: cb,
                                log: log,
                                name: 'put'
                        }),
                        reqCb: function (req) {
                                req.once('continue', function onContinue() {
                                        log.debug('put: continue receieved');
                                        input.pipe(req);
                                        input.resume();
                                });
                        }
                }));

                return;
        });
};


/**
 * Deletes a tree of keys from Manta.
 *
 * Parameters:
 *  - p: path to object
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.rmr = function rmr(p, opts, cb) {
        assert.string(p, 'path');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.object(opts, 'options');
        assert.func(cb, 'callback');

        var _done = false;
        var id = opts.req_id || uuid.v4();
        var inflight = 0;
        var _path = getPath(p, this.user);
        var nodes = [];
        var log = this.log.child({
                path: _path,
                req_id: id
        }, true);
        var _opts = {
                headers: opts.headers,
                req_id: id,
                limit: opts.limit || 10240,
                offset: opts.offset || 0
        };
        var self = this;

        log.debug('rmr: entered');

        function done(err) {
                if (!_done) {
                        log.trace({
                                path: p,
                                err: err
                        }, 'rmr: %s', err ? 'error' : 'done');
                        _done = true;
                        cb(err);
                }
        }

        function _remove() {
                var tasks = [];

                nodes = nodes.sort().reverse();
                log.trace({
                        path: _path,
                        nodes: nodes
                }, 'rmr: all children listed; deleting');

                nodes.forEach(function (n) {
                        if (/^\/\w+\/stor\/?$/.test(n)) {
                                tasks.push(function (_, _cb) { _cb(); });
                        } else {
                                tasks.push(function (_, _cb) {
                                        self.unlink(n, _opts, _cb);
                                });
                        }
                });

                vasync.pipeline({funcs: tasks}, done);
        }

        function remove() {
                process.nextTick(function () {
                        if (--inflight === 0)
                                _remove();
                });
        }

        function list(_p) {


                nodes.push(_p);
                inflight++;
                self.ls(_p, _opts, function (err, res) {
                        if (err) {
                                done(err);
                                return;
                        }

                        res.once('end', remove);
                        res.once('error', done.bind(self));

                        res.on('object', function (o) {
                                var k = _p + '/' + o.name;
                                inflight++;
                                self.unlink(k, _opts, function (err2) {
                                        if (err2) {
                                                done(err2);
                                        } else {
                                                remove();
                                        }
                                });
                        });

                        res.on('directory', function (d) {
                                list(_p + '/' + d.name);
                        });
                });
        }

        list(_path);
};


/**
 * Deletes an object or directory from Manta. If path points to a directory,
 * the directory *must* be empty.
 *
 * Parameters:
 *  - p: path to object
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.unlink = function unlink(p, opts, cb) {
        assert.string(p, 'path');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.object(opts, 'options');
        assert.func(cb, 'callback');

        var _path = getPath(p, this.user);
        var options = createOptions({
                accept: 'application/json',
                path: _path
        }, opts);
        var log = this.log.child({
                path: _path,
                req_id: options.id
        }, true);
        var self = this;

        log.debug(options, 'unlink: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.client.del(options, onRequestCallback({
                        cb: cb,
                        log: log,
                        name: 'unlink',
                        onResult: onResultCallback({
                                cb: cb,
                                log: log,
                                name: 'unlink'
                        })
                }));

                return;
        });
};


///--- Jobs API

/**
 * Creates a new compute job in Manta.
 *
 * This API is fairly flexible about what it takes, but really the best
 * thing is for callers to just fully spec out the JSON object, like so:
 *
 * {
 *     name: "word count",
 *     phases: [ {
 *         exec: "wc"
 *     }, {
 *         type: "reduce",
 *         exec: "awk '{ l += $1; w += $2; c += $3 } END { print l, w, c }'"
 *     } ]
 * }
 *
 * Alternatively, you can "cheat" for simple jobs and do this:
 *
 * createJob("grep foo", function (err, job) { ... });
 * createJob(["grep foo", "grep bar"], function (err, job) { ... });
 *
 * Note you can't specify a reduce task using the shorthand, so it's really
 * only useful for a distributed grep, and similar things.
 *
 * The callback will return you a string like '/mark/jobs/123-456-7890',
 * pass that in to subsequent client calls (like addJobKey).
 *
 * Parameters:
 *  - j: job configuration
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, jobPath)
 */
MantaClient.prototype.createJob = function createJob(j, opts, cb) {
        var job = cloneJob(j);
        assert.object(job, 'job');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.func(cb, 'callback');
        assert.ok(opts.user || this.user, 'user must be specified');

        var _path = getJobPath('', opts.user || this.user);
        var options = createOptions({
                accept: 'application/json',
                contentType: 'application/json; type=job',
                path: _path
        }, opts);
        var log = this.log.child({
                path: _path,
                req_id: options.id
        }, true);
        var self = this;

        if (!job.name)
                job.name = uuid.v4().substr(0, 7);

        log.debug({
                job: job,
                options: options
        }, 'createJob: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.jsonClient.post(options, job, function (err2, _, res) {
                        if (err2) {
                                log.debug(err, 'createJob: failed');
                                cb(err2);
                        } else {
                                var l = res.headers.location;
                                if (self.user)
                                        l = l.split(/\/.+\/jobs\//).pop();

                                log.debug({job: l}, 'createJob: done');
                                cb(null, l);
                        }
                });

                return;
        });
};


/**
 * Retrieves a job from Manta.
 *
 * Note this is only the high-level job object, not the input or output
 * keys.  You'll get back something like this:
 *
 *  {
 *      "id": "9b367fec-e565-4036-9696-2bf2f578aff6",
 *      "name": "72d7f19",
 *      "state": "done",
 *      "cancelled": false,
 *      "inputDone": true,
 *      "timeCreated": "2012-09-11T19:09:47.010Z",
 *      "timeDone": "2012-09-11T19:09:56.698Z",
 *      "phases": [ {
 *          "exec": "grep foo",
 *          "type": "storage-map"
 *      } ]
 *  }
 *
 * Parameters:
 *  - j: job path
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, job)
 */
MantaClient.prototype.job = function getJob(j, opts, cb) {
        assert.string(j, 'job');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.func(cb, 'callback');

        var _path = getJobPath(j, this.user);
        var options = createOptions({
                accept: 'application/json',
                path: _path
        }, opts);
        var log = this.log.child({
                path: _path,
                req_id: options.id
        }, true);
        var self = this;

        log.debug({
                job: j,
                options: options
        }, 'getJob: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.jsonClient.get(options, function (err2, _, __, obj) {
                        if (err2) {
                                log.debug(err, 'createJob: failed');
                                cb(err2);
                        } else {
                                log.debug({job: obj}, 'getJob: done');
                                cb(null, obj);
                        }
                });

                return;
        });
};


/**
 * Lists all jobs in Manta.
 *
 * Note this is only the high-level job object, not the input or output
 * keys.  You'll get back something like this:
 *
 *  {
 *      "id": "9b367fec-e565-4036-9696-2bf2f578aff6",
 *      "name": "72d7f19",
 *      "state": "done",
 *      "cancelled": false,
 *      "inputDone": true,
 *      "timeCreated": "2012-09-11T19:09:47.010Z",
 *      "timeDone": "2012-09-11T19:09:56.698Z",
 *      "phases": [ {
 *          "exec": "grep foo",
 *          "type": "storage-map"
 *      } ]
 *  }
 *
 * Parameters:
 *  - j: job path
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, job)
 */
MantaClient.prototype.listJobs = function listJobs(opts, cb) {
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.func(cb, 'callback');

        var _path = getJobPath('', this.user);
        var emitter = new EventEmitter();
        var options = createOptions({
                accept: 'application/x-json-stream',
                path: _path
        }, opts);
        var log = this.log.child({
                path: _path,
                req_id: options.id
        }, true);
        var self = this;


        log.debug('listJobs: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.client.get(options, onRequestCallback({
                        cb: cb,
                        log: log,
                        name: 'listJobs',
                        onResult: onResultCarrierCallback({
                                emitter: emitter,
                                emitCb: function (res, line) {
                                        var j;

                                        try {
                                                j = JSON.parse(line);
                                        } catch (e) {
                                                log.warn({
                                                        line: line,
                                                        err: e
                                                }, 'ls: invalid JSON data');
                                                res.removeAllListeners('data');
                                                res.removeAllListeners('end');
                                                res.removeAllListeners('error');
                                                emitter.emit('error', e);
                                        }

                                        emitter.emit('job', j);
                                },
                                log: log,
                                name: 'listJobs'
                        }),
                        reqCb: function () {
                                cb(null, emitter);
                        }
                }));

                return;
        });
};


/**
 * Submits job key(s) to an existing job in Manta.
 *
 * key can be either a single key or an array of keys.
 *
 * The keys themselves can either be "fully" pathed, like '/mark/stor/foo', or
 * if user was set, and the keys are under the callers account, then short-
 * handed, like so:
 *
 * var client = manta.createClient({ ..., user: 'mark' });
 * var keys = [
 *   'foo',               // mark/stor/foo
 *   '/dave/stor/bar',
 * ];
 * client.addJobKey('123', keys, function (err) { ... });
 *
 * In the options block, in addition to the usual stuff,  you can pass
 * 'end: true' to close input for this job (so you can avoid calling
 * endJob).
 *
 * Parameters:
 *  - j: job path
 *  - k: string key or array of string keys (see above).
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, job)
 */
MantaClient.prototype.addJobKey = function addJobKey(j, k, opts, cb) {
        assert.string(j, 'job');
        if (!Array.isArray(k)) {
                assert.string(k, 'key');
                k = [k];
        } else {
                assert.arrayOfString(k, 'keys');
        }
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.func(cb, 'callback');

        var self = this;
        var _path = getJobPath(j, this.user) + '/in';
        var options = createOptions({
                accept: 'application/json',
                contentType: 'text/plain',
                path: _path
        }, opts);
        var keys = k.map(function (key) {
                /* JSSTYLED */
                if (/^\/.*\/stor\/.*/.test(key))
                        return (key);
                return (getPath(key, self.user).replace(/\r?\n$/, ''));
        });
        var log = this.log.child({
                path: _path,
                req_id: options.id
        }, true);

        if (opts.end)
                options.path += '?end=true';

        log.debug({
                job: j,
                keys: keys,
                options: options
        }, 'addJobKey: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.client.post(options, onRequestCallback({
                        cb: cb,
                        log: log,
                        name: 'addJobJey',
                        onResult: onResultCallback({
                                cb: cb,
                                log: log,
                                name: 'addJobJey'
                        }),
                        reqCb: function (req) {
                                req.write(keys.join('\r\n'));
                                req.end();
                        }
                }));

                return;
        });
};


/**
 * Closes input for a job.
 *
 * Parameters:
 *  - j: job path
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, job)
 */
MantaClient.prototype.endJob = function endJob(j, opts, cb) {
        assert.string(j, 'job');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.func(cb, 'callback');

        var _path = getJobPath(j, this.user) + '/in/end';
        var options = createOptions({
                accept: 'application/json',
                contentLength: 0,
                contentType: 'application/json',
                path: _path
        }, opts);
        var log = this.log.child({
                path: _path,
                req_id: options.id
        }, true);
        var self = this;

        log.debug({
                job: j,
                options: options
        }, 'endJob: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.jsonClient.post(options, function (err2) {
                        if (err2) {
                                log.debug(err, 'endJob: error');
                                cb(err2);
                        } else {
                                log.debug('endJob: done');
                                cb(null);
                        }
                });

                return;
        });
};



/**
 * Retrieves all (current) output keys for a job, as a stream.
 *
 * client.jobOutput('123', function (err, out) {
 *     assert.ifError(err);
 *
 *     out.on('key', function (k) {
 *         console.log(k);
 *     });
 *
 *     res.once('end', function () {
 *         console.log('done');
 *     });
 * });
 *
 * Parameters:
 *  - j: job identifiedr
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, emitter)
 */
MantaClient.prototype.jobOutput = function getJobOutput(j, opts, cb) {
        assert.string(j, 'job');
        if (typeof (opts) === 'function') {
                cb = opts;
                opts = {};
        }
        assert.func(cb, 'callback');

        var _path = getJobPath(j, this.user) + '/out';
        var emitter = new EventEmitter();
        var options = createOptions({
                accept: 'application/x-json-stream',
                path: _path
        }, opts);
        var log = this.log.child({
                path: _path,
                req_id: options.id
        }, true);
        var self = this;

        log.debug({
                job: j,
                options: options
        }, 'jobOutput: entered');
        signRequest({
                headers: options.headers,
                sign: self.sign
        }, function onSignRequest(err) {
                if (err) {
                        cb(err);
                        return;
                }

                self.client.get(options, onRequestCallback({
                        cb: cb,
                        log: log,
                        name: 'ls',
                        onResult: onResultCarrierCallback({
                                emitter: emitter,
                                emitCb: function (res, line) {
                                        line = line.replace(/\r?\n$/, '');
                                        emitter.emit('key', line);
                                },
                                log: log,
                                name: 'ls'
                        }),
                        reqCb: function () {
                                cb(null, emitter);
                        }
                }));

                return;
        });
};