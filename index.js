'use strict'

const url = require('url'),
  net = require('net'),
  http = require('http'),
  fs = require('fs'),
  path = require('path'),
  socksv5 = require('socksv5')

module.exports = function(pacFileName, listenPort) {
  const loadPacFile = file => Function(fs.readFileSync(file, 'utf-8') + '; return FindProxyForURL')()

  let FindProxyForURL = loadPacFile(pacFileName)
  console.log(`[c] loaded ${pacFileName}`)
  fs.watchFile(pacFileName, { interval: 2000 }, () => {
    console.log(`[c] reloading ${pacFileName}`)
    FindProxyForURL = loadPacFile(pacFileName)
  })

  function getProxyOpts(reqUrl, reqHost) {
    const proxyCmd = FindProxyForURL(reqUrl, reqHost),
      proxySplit = proxyCmd.split(';').shift().split(' '),
      proxyMethod = proxySplit[0],
      addr = proxySplit.pop().split(':'),
      host = addr[0],
      port = parseInt(addr[1])
    if (proxyMethod === 'HTTP' || proxyMethod === 'PROXY') return {
      proxyCmd,
      useProxy: true,
      host, port,
    }
    else if (proxyMethod === 'SOCKS5') return {
      proxyCmd,
      useSocks: true,
      proxyHost: host,
      proxyPort: port,
      localDNS: false,
      auths: [ socksv5.auth.None() ]
    }
    else if (proxyCmd === 'DIRECT') return {
      proxyCmd,
    }
    else {
      throw 'not implemented'
    }
  }

  function sockList(url) {
    const socks = [ ]
    function onError(err) {
      console.error('ERR from: ', url, '\n    message: ', err)
      socks.forEach(sock => sock.destroy())
    }
    function regSock(sock) {
      if (socks.indexOf(sock) === -1) {
        socks.push(sock)
        sock.on('error', onError)
      }
      return sock
    }
    ;[].slice.call(arguments, 1).forEach(regSock)
    return regSock
  }

  // http://stackoverflow.com/questions/8165570/https-proxy-server-in-node-js
  const server = http.createServer()

  // http
  server.addListener('request', (req, res) => {
    const reqUrl = req.url.match(/^\w+:\/\//) ? req.url : 'http://' + req.url,
      regSock = sockList(reqUrl, req, res),
      parse = url.parse(reqUrl)

    if (req.url.match(/\/.+\.pac$/)) {
      res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' })
      return regSock(fs.createReadStream(pacFileName)).pipe(res)
    }

    const opts = {
      host: parse.hostname,
      port: parse.port || 80,
      path: parse.path,
      method: req.method,
      headers: req.headers,
    }

    try {
      Object.assign(opts, getProxyOpts(reqUrl, parse.hostname))
      console.log('[i]', reqUrl, '->', opts.proxyCmd)
    }
    catch (err) {
      return res.end(`HTTP/${req.httpVersion} 500 OK\r\n\r\n${err.message || err || 'Boom!'}`)
    }

    if (opts.useProxy) {
      // this fix squid invalid url issue
      if (opts.path.startsWith('/')) {
        opts.path = req.url
      }
    }

    if (opts.useSocks) {
      const addr = 'socks5:' + opts.proxyHost + ':' + opts.proxyPort
      opts.agent = server[addr] || (server[addr] = new socksv5.HttpAgent({
        proxyHost: opts.proxyHost,
        proxyPort: opts.proxyPort,
        auths: opts.auths,
      }))
    }

    const proxyReq = http.request(opts, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      regSock(proxyRes).pipe(res)
    })
    req.pipe(regSock(proxyReq))
  })

  // https
  server.addListener('connect', (req, res, headers) => {
    const reqUrl = req.url.match(/^\w+:\/\//) ? req.url : 'https://' + req.url,
      regSock = sockList(reqUrl, req, res),
      parse = url.parse(reqUrl)

    const opts = {
      host: parse.hostname,
      port: parse.port || 443,
    }

    try {
      Object.assign(opts, getProxyOpts(reqUrl, parse.hostname))
      console.log('[i]', reqUrl, '->', opts.proxyCmd)
    }
    catch (err) {
      return res.end(`HTTP/${req.httpVersion} 500 OK\r\n\r\n${err.message || err || 'Boom!'}`)
    }

    if (opts.useSocks) {
      socksv5.createConnection(opts, proxySock => {
        res.write(`HTTP/${req.httpVersion} 200 Connection established\r\n\r\n`)
        regSock(proxySock).write(headers)
        proxySock.pipe(res)
        res.pipe(proxySock)
      })
    }
    else {
      const proxySock = net.connect(opts, _ => {
        if (opts.useProxy) {
          proxySock.write(`CONNECT ${req.url} HTTP/${req.httpVersion}\r\n\r\n`)
        }
        else {
          res.write(`HTTP/${req.httpVersion} 200 Connection established\r\n\r\n`)
        }
        proxySock.write(headers)
        proxySock.pipe(res)
      })
      res.pipe(regSock(proxySock))
    }
  })

  server.listen(listenPort)
}
